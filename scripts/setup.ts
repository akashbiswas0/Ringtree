import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { parse } from "yaml";
import { Wallet, getAddress, hexlify, randomBytes } from "ethers";
import { dataDir } from "../server/config";
import { ask, hidden, save } from "./io";
import { checkRing, ringTransform } from "../server/wallet-cli";
async function main() {
  const command = process.argv[2] ?? "config";
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (command === "config") {
    const owner = getAddress(
      await ask("Ledger Ethereum address (verify on Flex first): "),
    );
    const sessionPath = join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "ledger-wallet-cli",
      "session.yaml",
    );
    const session = existsSync(sessionPath)
      ? parse(readFileSync(sessionPath, "utf8"))
      : {};
    save(join(dataDir, "config.json"), {
      owner,
      salt: hexlify(randomBytes(32)),
      model: "gpt-5.6-terra",
      allowBroadcast: false,
      ringBackend: "cli",
      ...(session.trustchain
        ? {
            keyRingRootId: session.trustchain.rootId,
            keyRingApplicationPath: session.trustchain.applicationPath,
          }
        : {}),
    });
    console.log(
      "Owner pinned. Restart the broker, then run npm run setup -- secret when your Key Ring and OpenAI key are ready.",
    );
    return;
  }
  if (command === "secret") {
    if (existsSync(join(dataDir, "openai.enc")))
      throw new Error(
        "Encrypted secret already exists; refusing to overwrite.",
      );
    const password = await hidden(
      "Existing wallet-cli ring password (hidden): ",
    );
    console.log("Checking Key Ring access with non-sensitive probe text…");
    await checkRing(password);
    console.log("Key Ring encryption and decryption verified.");
    const key = await hidden(
      "OpenAI API key (hidden, never saved as plaintext): ",
    );
    if (!key.startsWith("sk-") || key.includes("\n"))
      throw new Error("Invalid key format.");
    const input = Buffer.from(key);
    let bytes: Buffer;
    try { bytes = await ringTransform("encrypt", input, password); }
    finally { input.fill(0); }
    writeFileSync(join(dataDir, "openai.enc"), bytes, {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      "OpenAI key encrypted by wallet-cli ring. No plaintext key was saved.",
    );
    return;
  }
  if (command === "graph-secret") {
    if (existsSync(join(dataDir, "graph.enc")))
      throw new Error(
        "Encrypted Graph credential already exists; refusing to overwrite.",
      );
    const password = await hidden(
      "Existing wallet-cli ring password (hidden): ",
    );
    console.log("Checking Key Ring access with non-sensitive probe text…");
    await checkRing(password);
    const key = await hidden(
      "The Graph Gateway API key (hidden, never saved as plaintext): ",
    );
    if (key.length < 16 || key.length > 512 || /\s/.test(key))
      throw new Error("Invalid Graph Gateway key format.");
    const input = Buffer.from(key);
    let bytes: Buffer;
    try {
      bytes = await ringTransform("encrypt", input, password, "ringtree-graph");
    } finally {
      input.fill(0);
    }
    writeFileSync(join(dataDir, "graph.enc"), bytes, {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      "Graph Gateway key encrypted by wallet-cli ring. No plaintext key was saved.",
    );
    return;
  }
  if (command === "payment-wallet") {
    const encryptedPath = join(dataDir, "payment.enc");
    const publicPath = join(dataDir, "payment-address.json");
    if (existsSync(encryptedPath) || existsSync(publicPath))
      throw new Error("Graph Agent payment wallet already exists.");
    const password = await hidden(
      "Existing wallet-cli ring password (hidden): ",
    );
    await checkRing(password);
    const wallet = Wallet.createRandom();
    const input = Buffer.from(wallet.privateKey);
    let bytes: Buffer;
    try {
      bytes = await ringTransform(
        "encrypt",
        input,
        password,
        "ringtree-agent-payment",
      );
    } finally {
      input.fill(0);
    }
    writeFileSync(encryptedPath, bytes, { mode: 0o600, flag: "wx" });
    writeFileSync(
      publicPath,
      JSON.stringify({ address: wallet.address }, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    console.log(`Graph Agent payment address: ${wallet.address}`);
    console.log(
      "Its private key is encrypted by wallet-cli ring and was not printed.",
    );
    return;
  }
  if (command === "check") {
    const password = await hidden("Existing wallet-cli ring password (hidden): ");
    await checkRing(password);
    console.log("Key Ring encryption and decryption verified. You can now run npm run setup -- secret.");
    return;
  }
  if (command === "serve") {
    const password = await hidden(
      "Key Ring password for this broker session (hidden): ",
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/main.ts"],
      { env: { ...process.env, WALLET_PASS: password }, stdio: "inherit" },
    );
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  if (command === "status") {
    console.log({
      configured: existsSync(join(dataDir, "config.json")),
      encryptedSecret: existsSync(join(dataDir, "openai.enc")),
      encryptedGraphSecret: existsSync(join(dataDir, "graph.enc")),
      encryptedPaymentWallet: existsSync(join(dataDir, "payment.enc")),
      remoteMember: existsSync(join(dataDir, "member.enc.json")),
    });
    return;
  }
  if (command === "remote-password") {
    const password = await hidden(
      "Remote broker password for Docker (hidden): ",
    );
    if (password.length < 12) throw new Error("Use at least 12 characters.");
    const path = join(process.cwd(), ".ringtree", "remote-password");
    mkdirSync(join(process.cwd(), ".ringtree"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(path, password, { mode: 0o600, flag: "wx" });
    console.log(
      "Saved the operator-provided Docker secret. Only the broker service mounts it.",
    );
    return;
  }
  console.log("Commands: config | check | secret | graph-secret | payment-wallet | serve | status | remote-password");
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Setup failed");
  process.exitCode = 1;
});
