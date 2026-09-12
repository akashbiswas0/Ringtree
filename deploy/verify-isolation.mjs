import { existsSync } from "node:fs";
import assert from "node:assert/strict";
setTimeout(()=>{console.error("FAIL: isolation probe exceeded 20 seconds");process.exit(1);},20000).unref();
const state=await fetch("http://broker:4318/api/state",{signal:AbortSignal.timeout(5000)});
assert.equal(state.status,200,"agent must reach broker");
for(const key of ["WALLET_PASS","OPENAI_API_KEY","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN"])assert.equal(process.env[key],undefined,`${key} must not reach agents`);
for(const path of ["/data/config.json","/data/openai.enc","/data/graph.enc","/data/payment.enc","/data/payment-address.json","/run/ringtree-secrets/ring-password","/var/run/docker.sock","/home/node/.local/state/ledger-wallet-cli/session.yaml"])assert.equal(existsSync(path),false,`${path} must not be mounted`);
for(const url of ["https://api.openai.com","https://subgraphs.mcp.thegraph.com/sse","http://169.254.169.254/latest/meta-data/"]) {
  let reached=false;
  try{await fetch(url,{signal:AbortSignal.timeout(3000)});reached=true;}catch{}
  assert.equal(reached,false,`${url} must be unreachable`);
}
console.log("PASS: broker reachable; provider/metadata egress blocked; no broker secrets or AWS credential environment.");
// End the probe even if a failed DNS lookup retains a transport handle.
process.exit(0);
