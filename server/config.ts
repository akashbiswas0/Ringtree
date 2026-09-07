import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Address, Hash } from "../shared/protocol";
export const ConfigSchema = z
  .object({
    owner: Address,
    salt: Hash,
    model: z.string().default("gpt-4.1-mini"),
    allowBroadcast: z.boolean().default(false),
    ringBackend: z.literal("cli").default("cli"),
    keyRingRootId: z.string().optional(),
    keyRingApplicationPath: z.string().optional(),
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
