import { describe, expect, it } from "vitest";
import { intentFeeJitter } from "../server/tools";

describe("transaction intent uniqueness", () => {
  it("derives bounded, proposal-specific fee variation", () => {
    const a = `0x${"0".repeat(64)}`;
    const b = `0x${"0".repeat(63)}1`;
    expect(intentFeeJitter(a)).toBe(1n);
    expect(intentFeeJitter(b)).toBe(2n);
    expect(intentFeeJitter(`0x${"f".repeat(64)}`)).toBeLessThanOrEqual(
      1_048_576n,
    );
    expect(() => intentFeeJitter("not-a-hash")).toThrow("INVALID_INTENT_ID");
  });
});
