import { existsSync, writeFileSync } from "node:fs";
import { Wallet, hexlify, randomBytes } from "ethers";
import { sdk, seal } from "./lkrp";
import { hidden, save } from "./io";
import { canonical } from "../shared/protocol";
import { JoinRequest } from "../shared/enrollment";

// Operator-only interactive setup. Never send passwords via SSM RunCommand or S3.
async function main() {
  if (process.env.RINGTREE_DATA_DIR !== "/data") throw Error("Use the documented remote setup container.");
  if (existsSync("/data/member.enc.json") || existsSync("/secrets/ring-password")) throw Error("Remote member/password already exists. Refusing to overwrite.");
  const password = await hidden("Choose a NEW remote broker password (12+ characters, hidden): ");
  if (password.length < 12) throw Error("Use at least 12 characters.");
  if (await hidden("Confirm remote broker password (hidden): ") !== password) throw Error("Passwords do not match.");
  const member = await sdk().initMemberCredentials();
  const wallet = new Wallet("0x" + member.privatekey);
  const request = { memberPubkey: member.pubkey, name: "RingTree AWS broker", nonce: hexlify(randomBytes(32)), expiresAt: Math.floor(Date.now()/1000) + 3600 };
  const full = JoinRequest.parse({ ...request, proof: await wallet.signMessage(canonical(request)) });
  save("/data/member.enc.json", await seal(password, JSON.stringify(member)));
  writeFileSync("/secrets/ring-password", password, { mode: 0o600, flag: "wx" });
  save("/data/join-request.json", full);
  console.log("Remote member encrypted and saved. Next: download its PUBLIC join request and approve enrollment on Flex.");
}
main().catch(e=>{console.error(e instanceof Error ? e.message : "Remote setup failed");process.exitCode=1;});
