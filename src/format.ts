export function formatCount(value: string | undefined) {
  if (!value || !/^-?\d+$/.test(value)) return "--";
  return BigInt(value).toLocaleString("en-US");
}

export function formatStableAtomic(value: string | undefined) {
  if (!value || !/^-?\d+$/.test(value)) return "--";
  const raw = BigInt(value);
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  if (absolute === 0n) return "$0.00";
  const suffixes = [
    { units: 1_000_000_000_000_000_000n, suffix: "T" },
    { units: 1_000_000_000_000_000n, suffix: "B" },
    { units: 1_000_000_000_000n, suffix: "M" },
    { units: 1_000_000_000n, suffix: "K" },
  ];
  const abbreviated = suffixes.find(({ units }) => absolute >= units);
  if (abbreviated) {
    const tenths =
      (absolute * 10n + abbreviated.units / 2n) / abbreviated.units;
    const decimal = tenths % 10n;
    return `${negative ? "-" : ""}$${tenths / 10n}${
      decimal ? `.${decimal}` : ""
    }${abbreviated.suffix}`;
  }
  const cents = (absolute * 100n + 500_000n) / 1_000_000n;
  if (cents === 0n) return `${negative ? "-" : ""}<$0.01`;
  return `${negative ? "-" : ""}$${(cents / 100n).toLocaleString(
    "en-US",
  )}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function formatPercentChange(value: string | undefined) {
  if (!value || !/^-?\d+\.\d{2}$/.test(value)) return "--";
  if (value === "0.00" || value === "-0.00") return "0.00%";
  return `${value.startsWith("-") ? "" : "+"}${value}%`;
}
