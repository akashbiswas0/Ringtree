import { spawn } from "node:child_process";

export type RingKeyName =
  | "ringtree-openai"
  | "ringtree-graph"
  | "ringtree-agent-payment";

// Deliberately return only allowlisted explanations. CLI errors may contain user
// input, so neither stdout nor stderr is ever copied into an exception/log.
export function classifyRingFailure(output: string, exitCode: number | null) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "").toLowerCase();
  if (/wrong password|incorrect password|failed to decrypt private key/.test(text))
    return "The Key Ring password was not accepted. Use the password chosen for wallet-cli ring init, not your Ledger PIN.";
  if (/password must not be empty|password required|wallet_pass is (not set|empty)/.test(text))
    return "The Key Ring password is missing. Enter it at the hidden terminal prompt.";
  if (/not initialized|no trustchain/.test(text))
    return "The CLI could not find an initialized Key Ring in its current profile. Check HOME and XDG_STATE_HOME; do not reset an existing ring.";
  if (/not a member|not member|ejected|application stream is closed/.test(text))
    return "Ledger no longer recognizes this machine as an active Key Ring member. Check its membership before attempting recovery.";
  if (/keychain|keyring|secret service|dbus|private key not found|member credentials/.test(text))
    return "The CLI could not access this profile's OS keychain credential. Unlock your macOS login keychain and check any Keychain access prompt.";
  if (/certificate|tls|ssl/.test(text))
    return "The CLI could not establish a trusted TLS connection. Check proxy or certificate configuration; do not disable verification.";
  if (/fetch|network|enotfound|econn|timed? ?out|socket|dns/.test(text))
    return "The CLI could not reach Ledger's Key Ring service. Check your network or VPN and try again.";
  if (/401|403|unauthori[sz]ed|forbidden/.test(text))
    return "Ledger's Key Ring service refused authentication/access. The existing ring has been preserved.";
  if (/output.*json|unknown option|unknown argument|unexpected argument/.test(text))
    return "The installed wallet-cli rejected the invocation or output format. Check that the terminal uses wallet-cli 2.1.0.";
  if (/rotated|corrupted data|wrong key name/.test(text))
    return "The encrypted data could not be decrypted with the current Key Ring. Check whether the ring rotated; do not destroy it.";
  return `wallet-cli failed (exit ${exitCode ?? "signal"}). The CLI did not provide a recognized safe error category. No secrets were printed and the ring was left unchanged.`;
}

export async function ringTransform(
  operation: "encrypt" | "decrypt",
  input: Buffer,
  password: string | undefined,
  keyName: RingKeyName = "ringtree-openai",
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
      GNOME_KEYRING_CONTROL: process.env.GNOME_KEYRING_CONTROL,
    };
    if (password !== undefined) env.WALLET_PASS = password;
    const child = spawn("wallet-cli", ["ring", operation, "--output", "human", "--key", keyName], {
      env, stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outSize = 0, errSize = 0, settled = false;
    const wipe = () => { for (const b of [...stdout, ...stderr]) b.fill(0); };
    const fail = (message: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); wipe(); reject(new Error(message));
    };
    const timer = setTimeout(() => { child.kill(); fail("The Key Ring CLI timed out. Check OS keychain prompts and network connectivity, then retry."); }, 45000);
    child.stdout.on("data", (b: Buffer) => {
      if (settled) { b.fill(0); return; }
      outSize += b.length;
      if (outSize > 65536) { b.fill(0); child.kill(); fail("Key Ring output exceeded the expected size."); }
      else stdout.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      if (settled || errSize >= 16384) { b.fill(0); return; }
      errSize += b.length; stderr.push(b);
    });
    // An early CLI failure can close stdin before the payload is fully written.
    child.stdin.on("error", () => {});
    child.on("error", () => fail("Could not start wallet-cli. Check that it is installed and available in this terminal's PATH."));
    child.on("close", code => {
      if (settled) return;
      if (code !== 0) {
        const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
        const message = classifyRingFailure(err.toString("utf8") + "\n" + out.toString("utf8"), code);
        out.fill(0); err.fill(0); fail(message); return;
      }
      settled = true; clearTimeout(timer);
      const result = Buffer.concat(stdout); wipe(); resolve(result);
    });
    child.stdin.end(input);
  });
}

export async function checkRing(password: string) {
  if (!password) throw new Error("Enter a non-empty Key Ring password.");
  // Public probe text only; no OpenAI key is requested until this round-trip succeeds.
  const probe = Buffer.from("RingTree Key Ring connectivity check v1");
  const encrypted = await ringTransform("encrypt", probe, password);
  try {
    const decrypted = await ringTransform("decrypt", encrypted, password);
    try { if (!decrypted.equals(probe)) throw new Error("Key Ring round-trip returned unexpected data. No API key has been requested or saved."); }
    finally { decrypted.fill(0); }
  } finally { encrypted.fill(0); }
}
