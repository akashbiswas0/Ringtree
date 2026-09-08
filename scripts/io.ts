import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
export function save(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
}
export function read<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}
export async function ask(label: string) {
  const r = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await r.question(label)).trim();
  } finally {
    r.close();
  }
}
export async function hidden(label: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error("Run this command yourself in an interactive terminal.");
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    function onData(chunk: string) {
      for (const c of chunk) {
        if (c === "\u0003") {
          finish();
          reject(new Error("Cancelled"));
          return;
        }
        if (c === "\r" || c === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (c === "\u007f") {
          value = value.slice(0, -1);
        } else if (c >= " ") value += c;
      }
    }
    process.stdin.on("data", onData);
  });
}
