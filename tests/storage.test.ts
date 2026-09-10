import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { digest } from "../shared/protocol";
import { seal, unseal } from "../scripts/lkrp";
describe("durability and encrypted member envelopes", () => {
  it("persists replay prevention across broker restart", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "ringtree-test-")),
      "db.sqlite",
    );
    const a = new Store(path);
    a.once("unique");
    a.increment("parent");
    a.db.close();
    const b = new Store(path);
    expect(() => b.once("unique")).toThrow("REPLAY");
    expect(b.used("parent")).toBe(1);
    b.db.close();
  });
  it("links audit events by content hash", () => {
    const s = new Store(":memory:");
    s.event("TEST", { ok: true });
    s.event("TEST2", {});
    const e = s.events();
    expect(e[0].previous).toBe(e[1].hash);
    const { seq, hash, ...content } = e[0];
    expect(digest(content)).toBe(hash);
  });
  it("encrypts and authenticates member envelopes with the CLI-compatible PBKDF2 format", async () => {
    const password = "unit-test-only-not-a-wallet-password";
    const e = await seal(password, "unit-test fixture");
    expect(e.cipher).not.toContain("fixture");
    expect((await unseal(password, e.salt, e.cipher)).toString()).toBe(
      "unit-test fixture",
    );
    await expect(unseal("wrong", e.salt, e.cipher)).rejects.toThrow();
  }, 10000);
});
