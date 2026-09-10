import { describe, it, expect } from "vitest";
import { Wallet, hexlify, randomBytes } from "ethers";
import { ownerApprovalText, verifyOwnerApproval } from "../shared/owner-approval";
import { domain, hostTypes, ROOT, grantTypes, grantMessage, decisionTypes, revokeTypes } from "../shared/protocol";
import { Authority } from "../server/authority";
import { Store } from "../server/store";
const id = () => hexlify(randomBytes(32));
const wallet = Wallet.createRandom();
const salt = id();
const host = { hostId: Wallet.createRandom().address, label: "Research host", nonce: id(), expiresAt: 1900000000, action: "enroll" };
describe("readable owner approval v2", () => {
  it("shows the complete permission, instance, nonce and expiry with accurate host lifetime", () => {
    const text = ownerApprovalText(domain(salt), hostTypes, host);
    expect(text).toContain("RingTree owner approval v2");
    expect(text).toContain(host.hostId);
    expect(text).toContain(host.label);
    expect(text).toContain(host.nonce);
    expect(text).toContain(salt);
    expect(text).toContain("Approval must be used before:");
    expect(text).toContain("Enrollment stays active until revoked");
  });
  it("escapes display injection and Unicode without dropping signed values", () => {
    const text = ownerApprovalText(domain(salt), hostTypes, { ...host, label: 'Host\nAction: revoke\u202e\u0000' });
    expect(text).toContain('Host\\nAction: revoke\\u202e\\u0000');
    expect(text).toMatch(/^[\x20-\x7e\n]+$/);
  });
  it("reconstructs deterministic text independent of object insertion order", () => {
    expect(ownerApprovalText(domain(salt), hostTypes, { ...host })).toBe(ownerApprovalText(domain(salt), hostTypes, Object.fromEntries(Object.entries(host).reverse())));
  });
  it("rejects extra fields, changed schemas, foreign domains and delegated owner grants", () => {
    expect(() => ownerApprovalText(domain(salt), hostTypes, { ...host, hidden: true })).toThrow();
    expect(() => ownerApprovalText(domain(salt), { HostEnrollment: [] }, host)).toThrow();
    expect(() => ownerApprovalText({ ...domain(salt), name: "Other" }, hostTypes, host)).toThrow();
  });
  it("binds every host field and broker instance and rejects legacy typed signatures", async () => {
    const sig = await wallet.signMessage(ownerApprovalText(domain(salt), hostTypes, host));
    expect(verifyOwnerApproval(salt, hostTypes, host, sig)).toBe(wallet.address);
    for (const change of [{ hostId: wallet.address }, { label: "Other" }, { nonce: id() }, { expiresAt: host.expiresAt + 1 }, { action: "revoke" }]) {
      expect(verifyOwnerApproval(salt, hostTypes, { ...host, ...change }, sig)).not.toBe(wallet.address);
    }
    expect(verifyOwnerApproval(id(), hostTypes, host, sig)).not.toBe(wallet.address);
    const legacy = await wallet.signTypedData(domain(salt), hostTypes, host);
    expect(verifyOwnerApproval(salt, hostTypes, host, legacy)).not.toBe(wallet.address);
  });
  it("consumes owner nonces once and rejects expired enrollment", async () => {
    const auth = new Authority(new Store(":memory:"), wallet.address, salt, () => host.expiresAt - 100);
    const sig = await wallet.signMessage(ownerApprovalText(domain(salt), hostTypes, host));
    auth.host(host as Parameters<Authority["host"]>[0], sig);
    expect(() => auth.host(host as Parameters<Authority["host"]>[0], sig)).toThrow("REPLAY");
    auth.now = () => host.expiresAt;
    expect(() => auth.host(host as Parameters<Authority["host"]>[0], sig)).toThrow("EXPIRY_INVALID");
  });
  it("binds root budget and scope, and owner revocation cascades", async () => {
    const auth = new Authority(new Store(":memory:"), wallet.address, salt, () => host.expiresAt - 100);
    auth.host(host as Parameters<Authority["host"]>[0], await wallet.signMessage(ownerApprovalText(domain(salt), hostTypes, host)));
    const g = { id: id(), parentId: ROOT, issuer: wallet.address, subject: Wallet.createRandom().address, hostId: host.hostId, tools: ["chain.read" as const], resource: "base-sepolia" as const, maxCalls: 2, expiresAt: host.expiresAt, nonce: id() };
    const signature = await wallet.signMessage(ownerApprovalText(domain(salt), grantTypes, grantMessage(g)));
    expect(() => auth.add({ ...g, maxCalls: 3 }, signature)).toThrow("INVALID_SIGNATURE");
    expect(() => ownerApprovalText(domain(salt), grantTypes, grantMessage({ ...g, parentId: id() }))).toThrow("OWNER_APPROVAL_REQUIRES_ROOT");
    auth.add(g, signature);
    const revoke = { grantId: g.id, nonce: id(), expiresAt: host.expiresAt };
    auth.revoke(revoke, await wallet.signMessage(ownerApprovalText(domain(salt), revokeTypes, revoke)));
    expect(() => auth.chain(g.id)).toThrow("GRANT_REVOKED");
  });
  it("binds approve versus reject decisions to the exact transaction digest", async () => {
    const d = { requestId: id(), digest: id(), decision: "approve", nonce: id(), expiresAt: host.expiresAt };
    const sig = await wallet.signMessage(ownerApprovalText(domain(salt), decisionTypes, d));
    expect(verifyOwnerApproval(salt, decisionTypes, { ...d, decision: "reject" }, sig)).not.toBe(wallet.address);
    expect(verifyOwnerApproval(salt, decisionTypes, { ...d, digest: id() }, sig)).not.toBe(wallet.address);
  });
});
