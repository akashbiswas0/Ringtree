import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "ethers";
import { Store } from "../server/store";
import type { GrantRecord } from "../server/authority";

type Identity = { privateKey: string; hostPrivateKey: string };
type Proposal = {
  id: string;
  grantId: string;
  status: string;
  expiresAt: number;
  [key: string]: unknown;
};

function main() {
  if (process.env.RINGTREE_DATA_DIR !== "/data")
    throw new Error("Run only inside the documented AWS maintenance container.");
  const roleDir = process.env.RINGTREE_ROLE_DIR ?? "/identity";
  const identity = JSON.parse(
    readFileSync(join(roleDir, "identity.json"), "utf8"),
  ) as Identity;
  const subject = new Wallet(identity.privateKey).address;
  const store = new Store("/data/ringtree.sqlite");
  const now = Math.floor(Date.now() / 1000);
  const proposal = store
    .all<Proposal>("proposal")
    .findLast((item) => item.status === "pending");
  if (!proposal) throw new Error("NO_PENDING_PROPOSAL");
  const grant = store
    .all<GrantRecord>("grant")
    .findLast(
      (item) =>
        item.grant.subject === subject &&
        item.grant.tools.includes("tx.prepare") &&
        !item.revoked &&
        item.grant.expiresAt > now &&
        store.used(item.grant.id) < item.grant.maxCalls,
    );
  if (!grant) throw new Error("NO_EXECUTOR_BUDGET");
  const donePath = join(roleDir, "completed.json");
  const done = existsSync(donePath)
    ? (JSON.parse(readFileSync(donePath, "utf8")) as string[])
    : [];
  store.atomic(() => {
    store.put("proposal", proposal.id, {
      ...proposal,
      status: "rejected",
    });
    store.event("PROPOSAL_REPLACED_AFTER_REPLAY", {
      requestId: proposal.id,
      grantId: grant.grant.id,
    });
  });
  writeFileSync(
    donePath,
    JSON.stringify(done.filter((id) => id !== grant.grant.id)),
    { mode: 0o600 },
  );
  console.log(
    "Stale replaying proposal retained as rejected. Executor is ready to prepare one fresh transaction.",
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "REQUEUE_FAILED");
  process.exitCode = 1;
}
