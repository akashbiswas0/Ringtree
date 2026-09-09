import { verifyTypedData } from "ethers";
import { Store } from "./store";
import { verifyOwnerApproval } from "../shared/owner-approval";
import {
  type Call,
  type Grant,
  type Host,
  type SignedGrant,
  ROOT,
  domain,
  grantTypes,
  grantMessage,
  hostTypes,
  callTypes,
  callMessage,
  decisionTypes,
  type Decision,
  revokeTypes,
} from "../shared/protocol";

export type HostRecord = Host & { active: boolean };
export type GrantRecord = SignedGrant & { revoked: boolean };
export class Authority {
  constructor(
    public store: Store,
    public owner: string,
    public salt: string,
    public now = () => Math.floor(Date.now() / 1000),
  ) {}
  check(test: unknown, reason: string): asserts test {
    if (!test) throw new Error(reason);
  }
  signer(
    types: Parameters<typeof verifyTypedData>[1],
    message: Record<string, unknown>,
    sig: string,
  ) {
    try {
      return verifyTypedData(domain(this.salt), types, message, sig);
    } catch {
      throw new Error("INVALID_SIGNATURE");
    }
  }
  expiry(exp: number) {
    this.check(exp > this.now() && exp <= this.now() + 86400, "EXPIRY_INVALID");
  }
  private revokeTree(grantId: string) {
    const records = this.store.all<GrantRecord>("grant");
    const children = new Map<string, string[]>();
    for (const record of records) {
      const list = children.get(record.grant.parentId) ?? [];
      list.push(record.grant.id);
      children.set(record.grant.parentId, list);
    }
    const pending = [grantId];
    const changed: string[] = [];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const record = this.store.get<GrantRecord>("grant", id);
      if (record && !record.revoked) {
        this.store.put("grant", id, { ...record, revoked: true });
        changed.push(id);
      }
      pending.push(...(children.get(id) ?? []));
    }
    return changed;
  }
  reconcileDuplicateRoots() {
    const roots = this.store
      .all<GrantRecord>("grant")
      .filter(
        (record) =>
          record.grant.parentId === ROOT &&
          !record.revoked &&
          record.grant.expiresAt > this.now(),
      );
    const groups = new Map<string, GrantRecord[]>();
    for (const record of roots) {
      const key = `${record.grant.hostId}:${record.grant.subject}`;
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    this.store.atomic(() => {
      for (const records of groups.values()) {
        if (records.length < 2) continue;
        const keep = records.at(-1)!;
        const removed = records
          .slice(0, -1)
          .flatMap((record) => this.revokeTree(record.grant.id));
        this.store.event("DUPLICATE_ROOTS_RECONCILED", {
          retainedRootId: keep.grant.id,
          previousRootIds: records
            .slice(0, -1)
            .map((record) => record.grant.id),
          revokedGrantCount: removed.length,
        });
      }
    });
  }
  ownerSigner(types: Parameters<typeof verifyTypedData>[1], message: Record<string, unknown>, sig: string) {
    try { return verifyOwnerApproval(this.salt, types, message, sig); }
    catch { throw new Error("INVALID_SIGNATURE"); }
  }
  host(h: Host, signature: string) {
    this.expiry(h.expiresAt);
    this.check(
      this.ownerSigner(hostTypes, h, signature) === this.owner,
      "OWNER_SIGNATURE_REQUIRED",
    );
    this.store.atomic(() => {
      this.store.once(h.nonce);
      this.store.put("host", h.hostId, { ...h, active: h.action === "enroll" });
      this.store.event(
        h.action === "enroll" ? "HOST_ENROLLED" : "HOST_REVOKED",
        { host: h.hostId, label: h.label },
      );
    });
  }
  chain(id: string): GrantRecord[] {
    const chain: GrantRecord[] = [];
    const seen = new Set<string>();
    while (id !== ROOT) {
      this.check(!seen.has(id) && chain.length < 8, "INVALID_CHAIN");
      seen.add(id);
      const r = this.store.get<GrantRecord>("grant", id);
      this.check(r, "GRANT_UNKNOWN");
      this.check(!r.revoked, "GRANT_REVOKED");
      this.check(r.grant.expiresAt > this.now(), "GRANT_EXPIRED");
      this.check(
        this.store.get<HostRecord>("host", r.grant.hostId)?.active,
        "HOST_NOT_ENROLLED",
      );
      chain.push(r);
      id = r.grant.parentId;
    }
    this.check(chain.length, "INVALID_CHAIN");
    return chain;
  }
  add(g: Grant, signature: string) {
    this.expiry(g.expiresAt);
    this.check(g.id !== ROOT, "INVALID_GRANT_ID");
    this.check(
      this.store.get<HostRecord>("host", g.hostId)?.active,
      "HOST_NOT_ENROLLED",
    );
    this.check(
      (g.parentId === ROOT
        ? this.ownerSigner(grantTypes, grantMessage(g), signature)
        : this.signer(grantTypes, grantMessage(g), signature)) === g.issuer,
      "INVALID_SIGNATURE",
    );
    if (g.parentId === ROOT)
      this.check(g.issuer === this.owner, "OWNER_SIGNATURE_REQUIRED");
    else {
      const ancestors = this.chain(g.parentId);
      this.check(ancestors.length < 8, "DEPTH_LIMIT");
      const p = ancestors[0].grant;
      this.check(g.issuer === p.subject, "DELEGATOR_MISMATCH");
      this.check(
        g.tools.every((t) => p.tools.includes(t)),
        "SCOPE_ESCALATION",
      );
      this.check(g.resource === p.resource, "RESOURCE_ESCALATION");
      this.check(g.maxCalls <= p.maxCalls, "BUDGET_ESCALATION");
      this.check(g.expiresAt <= p.expiresAt, "EXPIRY_ESCALATION");
    }
    this.store.atomic(() => {
      this.check(!this.store.get("grant", g.id), "GRANT_EXISTS");
      this.store.once(g.nonce);
      if (g.parentId === ROOT) {
        const olderRoots = this.store
          .all<GrantRecord>("grant")
          .filter(
            (record) =>
              record.grant.parentId === ROOT &&
              record.grant.hostId === g.hostId &&
              record.grant.subject === g.subject &&
              record.grant.expiresAt > this.now(),
          );
        const superseded = olderRoots.flatMap((record) =>
          this.revokeTree(record.grant.id),
        );
        if (superseded.length)
          this.store.event("ROOT_SUPERSEDED", {
            replacementGrantId: g.id,
            previousRootIds: olderRoots.map((record) => record.grant.id),
            revokedGrantCount: superseded.length,
          });
      }
      this.store.put("grant", g.id, { grant: g, signature, revoked: false });
      this.store.event(
        g.parentId === ROOT ? "ROOT_AUTHORIZED" : "CAPABILITY_DELEGATED",
        {
          grantId: g.id,
          parentId: g.parentId,
          subject: g.subject,
          tools: g.tools,
        },
      );
    });
  }
  consume(c: Call) {
    return this.store.atomic(() => {
      const chain = this.chain(c.grantId);
      const g = chain[0].grant;
      this.check(Math.abs(this.now() - c.timestamp) <= 60, "STALE_REQUEST");
      this.check(
        this.signer(callTypes, callMessage(c), c.signature) === g.subject,
        "SENDER_MISMATCH",
      );
      this.check(
        this.signer(callTypes, callMessage(c), c.hostSignature) === g.hostId,
        "HOST_SIGNATURE_REQUIRED",
      );
      this.check(
        g.tools.includes(c.tool as Grant["tools"][number]),
        "TOOL_DENIED",
      );
      for (const item of chain)
        this.check(
          this.store.used(item.grant.id) < item.grant.maxCalls,
          "BUDGET_EXHAUSTED",
        );
      this.store.once(c.nonce);
      for (const item of chain) this.store.increment(item.grant.id);
      this.store.event("CALL_AUTHORIZED", {
        grantId: g.id,
        tool: c.tool,
        nonce: c.nonce,
        subject: g.subject,
      });
      return g;
    });
  }
  decision(d: Decision, signature: string) {
    this.expiry(d.expiresAt);
    this.check(
      this.ownerSigner(decisionTypes, d, signature) === this.owner,
      "OWNER_SIGNATURE_REQUIRED",
    );
    this.store.once(d.nonce);
  }
  revoke(
    payload: { grantId: string; nonce: string; expiresAt: number },
    signature: string,
  ) {
    this.expiry(payload.expiresAt);
    this.check(
      this.ownerSigner(revokeTypes, payload, signature) === this.owner,
      "OWNER_SIGNATURE_REQUIRED",
    );
    this.store.atomic(() => {
      const r = this.store.get<GrantRecord>("grant", payload.grantId);
      this.check(r, "GRANT_UNKNOWN");
      this.store.once(payload.nonce);
      const revoked = this.revokeTree(payload.grantId);
      this.store.event("GRANT_REVOKED", {
        grantId: payload.grantId,
        revokedGrantCount: revoked.length,
      });
    });
  }
}
