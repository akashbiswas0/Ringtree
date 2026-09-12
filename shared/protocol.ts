import { z } from "zod";
import {
  getAddress,
  keccak256,
  toUtf8Bytes,
  ZeroHash,
} from "ethers";

export const CHAIN_ID = 84532;
// Retained from the Flex signing demo agreed in this task.
export const DERIVATION_PATH = "44'/60'/0'/0/0";
export const TOOLS = [
  "tx.prepare",
  "graph.answer",
] as const;
export const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform(getAddress);
export const Hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const SignatureSchema = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const Tool = z.enum(TOOLS);
const limit = z.number().int().min(1).max(100);
const GrantSchema = z
  .object({
    id: Hash,
    parentId: Hash,
    issuer: Address,
    subject: Address,
    hostId: Address,
    tools: z
      .array(Tool)
      .min(1)
      .max(TOOLS.length)
      .refine((v) => new Set(v).size === v.length),
    resource: z.literal("base-sepolia"),
    maxCalls: limit,
    expiresAt: z.number().int().positive(),
    nonce: Hash,
  })
  .strict();
export type Grant = z.infer<typeof GrantSchema>;
export const SignedGrantSchema = z
  .object({ grant: GrantSchema, signature: SignatureSchema })
  .strict();
export type SignedGrant = z.infer<typeof SignedGrantSchema>;
export const CallSchema = z
  .object({
    grantId: Hash,
    tool: z.string().min(1).max(64),
    input: z.record(z.string(), z.unknown()),
    nonce: Hash,
    timestamp: z.number().int().positive(),
    signature: SignatureSchema,
    hostSignature: SignatureSchema,
  })
  .strict();
export type Call = z.infer<typeof CallSchema>;
export const HostSchema = z
  .object({
    hostId: Address,
    label: z.string().min(1).max(48),
    nonce: Hash,
    expiresAt: z.number().int().positive(),
    action: z.enum(["enroll", "revoke"]),
  })
  .strict();
export type Host = z.infer<typeof HostSchema>;
export const DecisionSchema = z
  .object({
    requestId: Hash,
    digest: Hash,
    decision: z.enum(["approve", "reject"]),
    nonce: Hash,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;

// Canonical JSON prevents input-key order from changing request identity.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonical((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
export const digest = (value: unknown) =>
  keccak256(toUtf8Bytes(canonical(value)));
export const domain = (salt: string) => ({
  name: "RingTree",
  version: "1",
  chainId: CHAIN_ID,
  salt,
});
export const grantTypes = {
  AgentGrant: [
    { name: "id", type: "bytes32" },
    { name: "parentId", type: "bytes32" },
    { name: "issuer", type: "address" },
    { name: "subject", type: "address" },
    { name: "hostId", type: "address" },
    { name: "tools", type: "string" },
    { name: "resource", type: "string" },
    { name: "maxCalls", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
export const grantMessage = (g: Grant) => ({
  ...g,
  tools: [...g.tools].sort().join(","),
});
export const hostTypes = {
  HostEnrollment: [
    { name: "hostId", type: "address" },
    { name: "label", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
    { name: "action", type: "string" },
  ],
};
export const callTypes = {
  CapabilityCall: [
    { name: "grantId", type: "bytes32" },
    { name: "tool", type: "string" },
    { name: "inputHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "timestamp", type: "uint256" },
  ],
};
export const callMessage = (
  c: Pick<Call, "grantId" | "tool" | "input" | "nonce" | "timestamp">,
) => ({
  grantId: c.grantId,
  tool: c.tool,
  inputHash: digest(c.input),
  nonce: c.nonce,
  timestamp: c.timestamp,
});
export const decisionTypes = {
  ActionDecision: [
    { name: "requestId", type: "bytes32" },
    { name: "digest", type: "bytes32" },
    { name: "decision", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
  ],
};
export const revokeTypes = {
  RevokeGrant: [
    { name: "grantId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
  ],
};
export const ROOT = ZeroHash;
export function typedGrant(g: Grant, salt: string) {
  return {
    domain: domain(salt),
    types: grantTypes,
    primaryType: "AgentGrant",
    message: grantMessage(g),
  };
}
