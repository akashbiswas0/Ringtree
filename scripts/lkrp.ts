import { createRequire } from "node:module";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "yaml";
import { Entry } from "@napi-rs/keyring";
import type {
  MemberCredentials,
  Trustchain,
  TrustchainSDK,
} from "@ledgerhq/ledger-key-ring-protocol/lib/types";

const require = createRequire(import.meta.url);
const { getSdk } = require("@ledgerhq/ledger-key-ring-protocol") as {
  getSdk: (mock: boolean, context: unknown, device: unknown) => TrustchainSDK;
};
export const sdk = () =>
  getSdk(
    false,
    {
      applicationId: 17,
      name: "RingTree broker",
      apiBaseUrl: "https://trustchain.api.live.ledger.com",
    },
    () => {
      throw new Error(
        "Hardware operation must run through the Ledger owner controller.",
      );
    },
  );
const buf = (v: Uint8Array) => Uint8Array.from(v);
export async function wrapping(password: string, salt: string) {
  const base = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return webcrypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: buf(Buffer.from(salt, "hex")),
      iterations: 600000,
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(password: string, data: string) {
  const salt = Buffer.from(
    webcrypto.getRandomValues(new Uint8Array(16)),
  ).toString("hex");
  const key = await wrapping(password, salt);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(data),
  );
  return { salt, cipher: Buffer.concat([iv, Buffer.from(ct)]).toString("hex") };
}
export async function unseal(password: string, salt: string, cipher: string) {
  const key = await wrapping(password, salt);
  const bytes = buf(Buffer.from(cipher, "hex"));
  return Buffer.from(
    await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      key,
      bytes.slice(12),
    ),
  );
}
export async function localMember(password: string) {
  // Mirrors wallet-cli 2.1.0: hashed profile directory and ENC password envelope.
  const dir = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "ledger-wallet-cli",
  );
  const session = parse(readFileSync(join(dir, "session.yaml"), "utf8")) as {
    passwordSalt?: string;
    trustchain?: { rootId: string; applicationPath: string };
  };
  if (!session.passwordSalt || !session.trustchain)
    throw new Error("Initialize a password-protected wallet-cli ring first.");
  const account =
    "member-private-key-" +
    createHash("sha256").update(dir).digest("hex").slice(0, 16);
  const stored = new Entry("ledger-wallet-cli", account).getPassword();
  if (!stored) throw new Error("Key Ring member not found in the OS keychain.");
  const [first, pubkey] = stored.trim().split(/\r?\n/);
  if (!first.startsWith("ENC:") || !pubkey)
    throw new Error(
      "Unsupported CLI keychain format. Password protection and public key are required.",
    );
  const privateBytes = await unseal(
    password,
    session.passwordSalt,
    first.slice(4),
  );
  try {
    return {
      member: { privatekey: privateBytes.toString(), pubkey },
      trustchain: {
        ...session.trustchain,
        walletSyncEncryptionKey: "",
      } as Trustchain,
    };
  } finally {
    privateBytes.fill(0);
  }
}
export async function installCliMember(
  password: string,
  member: MemberCredentials,
  ring: Trustchain,
) {
  const dir = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "ledger-wallet-cli",
  );
  const path = join(dir, "session.yaml");
  const account =
    "member-private-key-" +
    createHash("sha256").update(dir).digest("hex").slice(0, 16);
  const entry = new Entry("ledger-wallet-cli", account);
  if (existsSync(path) || entry.getPassword())
    throw new Error(
      "A CLI profile already exists. Use a fresh dedicated XDG_STATE_HOME for the remote broker.",
    );
  const enc = await seal(password, member.privatekey);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  entry.setPassword(`ENC:${enc.cipher}\n${member.pubkey}`);
  try {
    writeFileSync(
      path,
      stringify({
        accounts: [],
        trustchain: {
          rootId: ring.rootId,
          applicationPath: ring.applicationPath,
        },
        domains: [],
        passwordSalt: enc.salt,
      }),
      { mode: 0o600, flag: "wx" },
    );
  } catch (e) {
    entry.deletePassword();
    throw e;
  }
}
