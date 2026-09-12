import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Address, Hash } from "../shared/protocol";
const ConfigSchema = z
  .object({
    owner: Address,
    salt: Hash,
    model: z.string().default("gpt-5.6-terra"),
    allowBroadcast: z.boolean().default(false),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
export const dataDir = resolve(
  process.env.RINGTREE_DATA_DIR ?? ".ringtree/broker",
);
export function loadConfig(): Config | undefined {
  const path = resolve(dataDir, "config.json");
  return existsSync(path)
    ? ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    : undefined;
}
