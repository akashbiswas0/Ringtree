import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import {
  Wallet,
  SigningKey,
  verifyMessage,
  computeAddress,
  hexlify,
  randomBytes,
} from "ethers";
import {
  JoinRequest,
  JoinApproval,
  JoinBundle,
  joinMessage,
  joinTypes,
  approvalMessage,
} from "../shared/enrollment";
import { canonical, domain } from "../shared/protocol";
import { verifyOwnerApproval } from "../shared/owner-approval";
import { read, save, hidden, ask } from "./io";
import { sdk, localMember, seal, unseal, installCliMember } from "./lkrp";
import { Store } from "../server/store";
import { ConfigSchema } from "../server/config";
import type { MemberCredentials } from "@ledgerhq/ledger-key-ring-protocol/lib/types";

let failureStage = "startup";
function assertRemotePassword(password: string) {
  const path = "/run/ringtree-secrets/ring-password";
  if (!existsSync(path)) return;
  const expected = readFileSync(path);
  const supplied = Buffer.from(password);
  const matches =
    expected.length === supplied.length && timingSafeEqual(expected, supplied);
  expected.fill(0);
  supplied.fill(0);
  if (!matches) throw new Error("REMOTE_PASSWORD_REJECTED");
}

async function main() {
  const [command, file] = process.argv.slice(2);
  const dir = resolve(process.env.RINGTREE_DATA_DIR ?? ".ringtree/broker");
  if (command === "request") {
    if (existsSync(join(dir, "member.enc.json")))
      throw new Error(
        "A remote member already exists; refusing to overwrite it.",
      );
    const name = await ask("Name for this remote broker: ");
    const password = await hidden(
      "Choose a password for this remote member (hidden): ",
    );
    if (password.length < 12) throw new Error("Use at least 12 characters.");
    const member = await sdk().initMemberCredentials();
    const wallet = new Wallet("0x" + member.privatekey);
    const request = {
      memberPubkey: member.pubkey,
      name,
      nonce: hexlify(randomBytes(32)),
      expiresAt: Math.floor(Date.now() / 1000) + 1800,
    };
    const full = JoinRequest.parse({
      ...request,
      proof: await wallet.signMessage(canonical(request)),
    });
    save(
      join(dir, "member.enc.json"),
      await seal(password, JSON.stringify(member)),
    );
    save(join(dir, "join-request.json"), full);
    console.log(
      "Created public join-request.json. Import it into the owner dashboard, sign on Flex, then run ringlink approve on the laptop.",
    );
    return;
  }
  if (command === "approve" && file) {
    const a = JoinApproval.parse(read(file));
    const cfg = ConfigSchema.parse(read(join(dir, "config.json")));
    if (
      a.owner !== cfg.owner ||
      a.salt !== cfg.salt ||
      verifyOwnerApproval(
        a.salt,
        joinTypes,
        approvalMessage(a),
        a.signature,
      ) !== cfg.owner
    )
      throw new Error("Owner approval does not match the configured Ledger.");
    if (a.request.expiresAt <= Date.now() / 1000)
      throw new Error("Enrollment request expired.");
    if (
      verifyMessage(canonical(joinMessage(a.request)), a.request.proof) !==
      computeAddress("0x" + a.request.memberPubkey)
    )
      throw new Error("Remote key proof invalid.");
    const ledgerState = new Store(join(dir, "ringlink.sqlite"));
    // Consume approval before calling the remote API; failure requires a fresh request.
    ledgerState.once(a.request.nonce);
    const password = await hidden(
      "Existing wallet-cli ring password (hidden): ",
    );
    const local = await localMember(password);
    if (
      local.trustchain.rootId !== a.rootId ||
      local.trustchain.applicationPath !== a.applicationPath
    )
      throw new Error("Approval refers to a different Key Ring.");
    const client = sdk();
    const ring = await client.restoreTrustchain(local.trustchain, local.member);
    await client.addMember(ring, local.member, {
      id: a.request.memberPubkey,
      name: a.request.name,
      permissions: 1,
    }); // KEY_READER, never OWNER.
    save(resolve(file) + ".joined.json", {
      ...a,
      rootId: ring.rootId,
      applicationPath: ring.applicationPath,
    });
    console.log(
      "Remote broker added as KEY_READER. Transfer the .joined.json bundle and encrypted openai.enc to the remote broker.",
    );
    return;
  }
  if (command === "join" && file) {
    failureStage = "bundle-validation";
    const a = JoinBundle.parse(read(file));
    const all = a;
    const cfg = ConfigSchema.parse(read(join(dir, "config.json")));
    if (
      a.owner !== cfg.owner ||
      a.salt !== cfg.salt ||
      a.rootId !== cfg.keyRingRootId ||
      a.applicationPath !== cfg.keyRingApplicationPath ||
      verifyOwnerApproval(
        cfg.salt,
        joinTypes,
        approvalMessage(a),
        a.signature,
      ) !== cfg.owner
    )
      throw new Error("Owner approval invalid.");
    if (a.request.expiresAt <= Date.now() / 1000)
      throw new Error("Enrollment request expired.");
    failureStage = "password-entry";
    const password = await hidden("Remote member password (hidden): ");
    assertRemotePassword(password);
    failureStage = "member-decryption";
    const enc = read<{ salt: string; cipher: string }>(
      join(dir, "member.enc.json"),
    );
    const bytes = await unseal(password, enc.salt, enc.cipher);
    try {
      const member = JSON.parse(bytes.toString()) as MemberCredentials;
      if (
        SigningKey.computePublicKey("0x" + member.privatekey, true).slice(2) !==
        a.request.memberPubkey
      )
        throw new Error("Bundle is for a different host.");
      failureStage = "trustchain-restore";
      const ring = await sdk().restoreTrustchain(
        {
          rootId: all.rootId,
          applicationPath: all.applicationPath,
          walletSyncEncryptionKey: "",
        },
        member,
      );
      failureStage = "cli-profile-install";
      await installCliMember(password, member, ring);
      save(join(dir, "trustchain.json"), {
        rootId: ring.rootId,
        applicationPath: ring.applicationPath,
      });
      console.log(
        "Remote member installed into the official wallet-cli profile. Use wallet-cli ring keys and wallet-cli ring decrypt; no USB needed.",
      );
      failureStage = "complete";
    } finally {
      bytes.fill(0);
    }
    return;
  }
  if (command === "members") {
    const password = await hidden(
      "Existing wallet-cli ring password (hidden): ",
    );
    const local = await localMember(password);
    console.log(
      (await sdk().getMembers(local.trustchain, local.member)).map((m) => ({
        name: m.name,
        id: m.id,
        permissions: m.permissions,
      })),
    );
    return;
  }
  console.log(
    "Commands: request | approve <signed-approval.json> | join <approval.joined.json> | members",
  );
}
main().catch((error: unknown) => {
  const known = error instanceof Error && [
    "REMOTE_PASSWORD_REJECTED",
    "Enrollment request expired.",
    "Owner approval invalid.",
    "Bundle is for a different host.",
  ].includes(error.message) ? error.message : "SAFE_DIAGNOSTIC_ONLY";
  console.error(`RingLink failed at ${failureStage}: ${known}. No secret output is logged.`);
  process.exitCode = 1;
});
