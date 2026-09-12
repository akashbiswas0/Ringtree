import { describe, it, expect, beforeEach } from "vitest";
import { Wallet, hexlify, randomBytes } from "ethers";
import { Store } from "../server/store";
import { Authority } from "../server/authority";
import { ownerApprovalText } from "../shared/owner-approval";
import {
  ROOT,
  domain,
  grantTypes,
  grantMessage,
  hostTypes,
  callTypes,
  callMessage,
  type Grant,
  type Call,
} from "../shared/protocol";
const id = () => hexlify(randomBytes(32));
describe("Ledger-rooted capability enforcement", () => {
  let store: Store, authority: Authority;
  const owner = Wallet.createRandom(),
    host = Wallet.createRandom(),
    parent = Wallet.createRandom(),
    child = Wallet.createRandom(),
    stranger = Wallet.createRandom();
  let salt: string, root: Grant;
  const now = 1700000000;
  const signGrant = (g: Grant, w = parent) =>
    g.parentId === ROOT
      ? w.signMessage(ownerApprovalText(domain(salt), grantTypes, grantMessage(g)))
      : w.signTypedData(domain(salt), grantTypes, grantMessage(g));
  async function call(g: Grant, w = child, overrides: Partial<Call> = {}) {
    const b = {
      grantId: g.id,
      tool: "graph.answer",
      input: {},
      timestamp: now,
      nonce: id(),
      ...overrides,
    };
    return {
      ...b,
      signature: await w.signTypedData(domain(salt), callTypes, callMessage(b)),
      hostSignature: await host.signTypedData(
        domain(salt),
        callTypes,
        callMessage(b),
      ),
    };
  }
  const delegate = (patch: Partial<Grant> = {}): Grant => ({
    ...root,
    id: id(),
    parentId: root.id,
    issuer: parent.address,
    subject: child.address,
    tools: ["graph.answer"],
    maxCalls: 2,
    nonce: id(),
    ...patch,
  });
  beforeEach(async () => {
    store = new Store(":memory:");
    salt = id();
    authority = new Authority(store, owner.address, salt, () => now);
    const enrollment = {
      hostId: host.address,
      label: "test host",
      nonce: id(),
      expiresAt: now + 3600,
      action: "enroll" as const,
    };
    authority.host(
      enrollment,
      await owner.signMessage(ownerApprovalText(domain(salt), hostTypes, enrollment)),
    );
    root = {
      id: id(),
      parentId: ROOT,
      issuer: owner.address,
      subject: parent.address,
      hostId: host.address,
      tools: ["graph.answer"],
      resource: "base-sepolia",
      maxCalls: 3,
      expiresAt: now + 1800,
      nonce: id(),
    };
    authority.add(root, await signGrant(root, owner));
  });
  it("accepts a narrower delegated permission and charges every ancestor", async () => {
    const g = delegate();
    authority.add(g, await signGrant(g));
    authority.consume(await call(g));
    expect(store.used(g.id)).toBe(1);
    expect(store.used(root.id)).toBe(1);
  });
  it("supersedes the previous active root and its delegated tree", async () => {
    const delegated = delegate();
    authority.add(delegated, await signGrant(delegated));
    const replacement = {
      ...root,
      id: id(),
      expiresAt: now + 1700,
      nonce: id(),
    };
    authority.add(replacement, await signGrant(replacement, owner));
    expect(store.get<{ revoked: boolean }>("grant", root.id)?.revoked).toBe(true);
    expect(store.get<{ revoked: boolean }>("grant", delegated.id)?.revoked).toBe(true);
    expect(store.get<{ revoked: boolean }>("grant", replacement.id)?.revoked).toBe(false);
    expect(store.events().some((event) => event.type === "ROOT_SUPERSEDED")).toBe(true);
  });
  it("reconciles duplicate roots left by an older broker version", async () => {
    const delegated = delegate();
    authority.add(delegated, await signGrant(delegated));
    const newer = {
      ...root,
      id: id(),
      expiresAt: now + 1700,
      nonce: id(),
    };
    store.put("grant", newer.id, {
      grant: newer,
      signature: "legacy-record",
      revoked: false,
    });
    authority.reconcileDuplicateRoots();
    expect(store.get<{ revoked: boolean }>("grant", root.id)?.revoked).toBe(true);
    expect(store.get<{ revoked: boolean }>("grant", delegated.id)?.revoked).toBe(true);
    expect(store.get<{ revoked: boolean }>("grant", newer.id)?.revoked).toBe(false);
    expect(
      store.events().some(
        (event) => event.type === "DUPLICATE_ROOTS_RECONCILED",
      ),
    ).toBe(true);
  });
  it.each([
    ["scope", { tools: ["tx.prepare"] }],
    ["budget", { maxCalls: 4 }],
    ["expiry", { expiresAt: now + 2000 }],
  ])("rejects %s escalation", async (_name, patch) => {
    const g = delegate(patch as Partial<Grant>);
    expect(() => authority.add(g, "")).toThrow();
    const sig = await signGrant(g);
    expect(() => authority.add(g, sig)).toThrow(/ESCALATION/);
  });
  it("rejects a changed grant with the original signature", async () => {
    const g = delegate();
    const sig = await signGrant(g);
    expect(() => authority.add({ ...g, maxCalls: 3 }, sig)).toThrow(
      "INVALID_SIGNATURE",
    );
  });
  it("rejects a root signed by an agent instead of owner", async () => {
    const g = { ...root, id: id(), issuer: parent.address, nonce: id() };
    expect(() => authority.add(g, "")).toThrow();
    const sig = await signGrant(g);
    expect(() => authority.add(g, sig)).toThrow("OWNER_SIGNATURE_REQUIRED");
  });
  it("cannot steal another agent capability", async () => {
    const g = delegate();
    authority.add(g, await signGrant(g));
    const request = await call(g, stranger);
    expect(() => authority.consume(request)).toThrow("SENDER_MISMATCH");
  });
  it("requires the enrolled host signature", async () => {
    const g = delegate();
    authority.add(g, await signGrant(g));
    const request = await call(g);
    request.hostSignature = await stranger.signTypedData(
      domain(salt),
      callTypes,
      callMessage(request),
    );
    expect(() => authority.consume(request)).toThrow("HOST_SIGNATURE_REQUIRED");
  });
  it("binds exact arguments", async () => {
    const g = delegate();
    authority.add(g, await signGrant(g));
    const request = await call(g);
    request.input = { url: "https://attacker.invalid" };
    expect(() => authority.consume(request)).toThrow("SENDER_MISMATCH");
  });
  it("consumes nonce once", async () => {
    const g = delegate();
    authority.add(g, await signGrant(g));
    const request = await call(g);
    authority.consume(request);
    expect(() => authority.consume(request)).toThrow("REPLAY");
    expect(store.used(root.id)).toBe(1);
  });
  it("prevents cross-broker signature replay", async () => {
    const g = delegate();
    const sig = await signGrant(g);
    const foreign = new Authority(store, owner.address, id(), () => now);
    expect(() => foreign.add(g, sig)).toThrow("INVALID_SIGNATURE");
  });
  it("shares a parent budget across siblings", async () => {
    const a = delegate(),
      b = delegate({ subject: stranger.address });
    authority.add(a, await signGrant(a));
    authority.add(b, await signGrant(b));
    authority.consume(await call(a));
    authority.consume(await call(a));
    authority.consume(await call(b, stranger));
    const c = await call(b, stranger);
    expect(() => authority.consume(c)).toThrow("BUDGET_EXHAUSTED");
    expect(store.used(root.id)).toBe(3);
  });
  it("rejects revoked ancestor and expired requests", async () => {
    const g = delegate();
    authority.add(g, await signGrant(g));
    const request = await call(g);
    store.put("grant", root.id, { grant: root, revoked: true });
    expect(() => authority.consume(request)).toThrow("GRANT_REVOKED");
  });
  it("rejects stale sender requests", async () => {
    const g = delegate();
    authority.add(g, await signGrant(g));
    const request = await call(g, child, { timestamp: now - 61 });
    expect(() => authority.consume(request)).toThrow("STALE_REQUEST");
  });
  it("host revocation disables descendant calls", async () => {
    const g = delegate();
    authority.add(g, await signGrant(g));
    const h = {
      hostId: host.address,
      label: "test host",
      nonce: id(),
      expiresAt: now + 100,
      action: "revoke" as const,
    };
    authority.host(h, await owner.signMessage(ownerApprovalText(domain(salt), hostTypes, h)));
    const request = await call(g);
    expect(() => authority.consume(request)).toThrow("HOST_NOT_ENROLLED");
  });
});
