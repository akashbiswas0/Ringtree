import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
import { classifyRingFailure, ringTransform, checkRing } from "../server/wallet-cli";

function childExit(code: number, stdout: string, stderr = "") {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(),
  });
  child.stdin.on("finish", () => queueMicrotask(() => {
    child.stdout.write(Buffer.from(stdout));
    child.stderr.write(Buffer.from(stderr));
    child.emit("close", code);
  }));
  return child;
}

describe("safe Key Ring diagnostics", () => {
  it("identifies password failure without echoing CLI output", () => {
    const text = classifyRingFailure("Wrong password: failed to decrypt private key. sk-sensitive-example", 1);
    expect(text).toContain("password was not accepted");
    expect(text).not.toContain("sk-sensitive-example");
    expect(text).not.toContain("Initialize");
  });
  it("distinguishes profile, keychain, and network failures", () => {
    expect(classifyRingFailure("Ledger Key Ring not initialized", 1)).toContain("current profile");
    expect(classifyRingFailure("Cannot access keychain", 1)).toContain("OS keychain");
    expect(classifyRingFailure("fetch failed ECONNRESET", 1)).toContain("network");
  });
  it("never leaks unknown failure contents", () => {
    expect(classifyRingFailure("some arbitrary error with secret-value", 7)).not.toContain("secret-value");
    expect(classifyRingFailure("some arbitrary error with secret-value", 7)).toContain("exit 7");
  });
  it("reports the captured error instead of claiming the ring is uninitialized", async () => {
    spawnMock.mockReturnValueOnce(childExit(1, "", "Wrong password: failed to decrypt private key"));
    await expect(ringTransform("encrypt", Buffer.from("public-probe"), undefined)).rejects.toThrow("password was not accepted");
  });
  it("does not return partial output on failure", async () => {
    spawnMock.mockReturnValueOnce(childExit(1, "sensitive-output", "unknown problem"));
    await expect(ringTransform("decrypt", Buffer.from("ciphertext"), undefined)).rejects.not.toThrow("sensitive-output");
  });
  it("uses the separate fixed Key Ring name for Graph credentials", async () => {
    spawnMock.mockReturnValueOnce(childExit(0, "encrypted-graph-key"));
    await ringTransform(
      "encrypt",
      Buffer.from("graph-key-fixture"),
      "password-fixture",
      "ringtree-graph",
    );
    expect(spawnMock).toHaveBeenLastCalledWith(
      "wallet-cli",
      [
        "ring",
        "encrypt",
        "--output",
        "human",
        "--key",
        "ringtree-graph",
      ],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
  });
  it("validates public probe round-trip without an API key", async () => {
    spawnMock.mockReturnValueOnce(childExit(0, "encrypted-probe"));
    spawnMock.mockReturnValueOnce(childExit(0, "RingTree Key Ring connectivity check v1"));
    await expect(checkRing("isolated-mocked-process-fixture")).resolves.toBeUndefined();
  });
  it("rejects empty passwords before starting CLI", async () => {
    spawnMock.mockClear();
    await expect(checkRing("")).rejects.toThrow("non-empty");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
