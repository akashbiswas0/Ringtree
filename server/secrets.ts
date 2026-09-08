import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ringTransform, type RingKeyName } from "./wallet-cli";

export interface SecretProvider {
  ready(): boolean;
  unlocked(): boolean;
  withSecret<T>(fn: (secret: string) => Promise<T>): Promise<T>;
}
// No shell, caller-controlled executable, key name, file path, or environment passthrough.
export class RingSecret implements SecretProvider {
  constructor(
    private dir: string,
    private file = "openai.enc",
    private keyName: RingKeyName = "ringtree-openai",
    private validate: (value: string) => boolean = (value) =>
      value.startsWith("sk-") && !value.includes("\n"),
  ) {}
  ready() {
    return existsSync(join(this.dir, this.file));
  }
  unlocked() {
    return this.ready() && Boolean(process.env.WALLET_PASS);
  }
  async withSecret<T>(fn: (secret: string) => Promise<T>): Promise<T> {
    if (!this.ready()) throw new Error("KEY_RING_SECRET_NOT_CONFIGURED");
    if (!this.unlocked()) throw new Error("KEY_RING_UNLOCK_REQUIRED");
    const ciphertext = readFileSync(join(this.dir, this.file));
    const bytes = await ringTransform("decrypt", ciphertext, process.env.WALLET_PASS, this.keyName).catch((error: Error) => {
      if (error.message.includes("password was not accepted")) throw new Error("KEY_RING_PASSWORD_REJECTED");
      if (error.message.includes("OS keychain")) throw new Error("KEY_RING_KEYCHAIN_UNAVAILABLE");
      throw new Error("KEY_RING_UNAVAILABLE_RUN_SETUP_CHECK");
    });
    try {
      const secret = bytes.toString("utf8").trim();
      if (!this.validate(secret))
        throw new Error("KEY_RING_OUTPUT_INVALID");
      return await fn(secret);
    } finally {
      bytes.fill(0);
    }
  }
}

export function graphSecret(dir: string) {
  return new RingSecret(
    dir,
    "graph.enc",
    "ringtree-graph",
    (value) => value.length >= 16 && value.length <= 512 && !/\s/.test(value),
  );
}

export function paymentSecret(dir: string) {
  return new RingSecret(
    dir,
    "payment.enc",
    "ringtree-agent-payment",
    (value) => /^0x[0-9a-fA-F]{64}$/.test(value),
  );
}
