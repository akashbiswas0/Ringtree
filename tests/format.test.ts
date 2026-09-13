import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatPercentChange,
  formatStableAtomic,
} from "../src/format";

describe("Graph financial number formatting", () => {
  it("formats exact atomic USDC values without floating point", () => {
    expect(formatStableAtomic("0")).toBe("$0.00");
    expect(formatStableAtomic("42")).toBe("<$0.01");
    expect(formatStableAtomic("1234500")).toBe("$1.23");
    expect(formatStableAtomic("1234500000")).toBe("$1.2K");
    expect(formatStableAtomic("-42")).toBe("-<$0.01");
    expect(formatStableAtomic(undefined)).toBe("--");
  });

  it("formats changes and counts with stable signs and separators", () => {
    expect(formatPercentChange("12.34")).toBe("+12.34%");
    expect(formatPercentChange("-12.34")).toBe("-12.34%");
    expect(formatPercentChange("-0.00")).toBe("0.00%");
    expect(formatCount("1234567")).toBe("1,234,567");
    expect(formatCount("NaN")).toBe("--");
  });
});
