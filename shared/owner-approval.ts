import { TypedDataEncoder, verifyMessage, type TypedDataDomain, type TypedDataField } from "ethers";
import { domain, canonical, hostTypes, grantTypes, decisionTypes, revokeTypes, ROOT } from "./protocol";
import {
  X402_DAILY_BUDGET_LABEL,
  X402_MAX_PAYMENT_LABEL,
} from "./payment";

export const OWNER_APPROVAL_VERSION = 3;

const schemas = { ...hostTypes, ...grantTypes, ...decisionTypes, ...revokeTypes };
const purposes: Record<string, string> = {
  HostEnrollment: "Change agent host admission. Enrollment stays active until revoked. A separate grant is required to use tools.",
  AgentGrant: `Authorize scoped agent tools and narrower delegation. Graph queries may spend up to ${X402_MAX_PAYMENT_LABEL} each and ${X402_DAILY_BUDGET_LABEL} per UTC day from the separate agent wallet. No API key export. No transaction signing authority.`,
  ActionDecision: "Record a workflow decision for the exact transaction digest below. Moving funds still requires a separate transaction signature.",
  RevokeGrant: "Revoke this grant and block its descendants on their next request.",
};
const labels: Record<string, string> = {
  hostId: "Host address", label: "Host label", action: "Action",
  id: "Grant ID", parentId: "Parent grant", issuer: "Owner address",
  subject: "Agent address", tools: "Allowed tools", resource: "Resource",
  maxCalls: "Maximum calls (shared with descendants)", nonce: "One-time nonce",
  requestId: "Request ID", digest: "Exact transaction digest", decision: "Decision",
  grantId: "Grant ID",
};

// Serialize values without control characters, newlines, bidi, or Unicode lookalikes.
// Browser and verifier reconstruct these exact bytes; neither accepts supplied display text.
function printable(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") throw Error("INVALID_APPROVAL_VALUE");
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw Error("INVALID_APPROVAL_VALUE");
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function ownerApprovalText(
  approvalDomain: TypedDataDomain,
  types: Record<string, TypedDataField[]>,
  message: Record<string, unknown>,
): string {
  const keys = Object.keys(types).filter(k => k !== "EIP712Domain");
  const kind = keys[0];
  const fields = schemas[kind as keyof typeof schemas];
  if (keys.length !== 1 || !fields || canonical(types[kind]) !== canonical(fields)) throw Error("UNSUPPORTED_OWNER_APPROVAL");
  if (typeof approvalDomain.salt !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(approvalDomain.salt) || canonical(approvalDomain) !== canonical(domain(approvalDomain.salt))) throw Error("INVALID_APPROVAL_DOMAIN");
  if (Object.keys(message).length !== fields.length || fields.some(f => !(f.name in message))) throw Error("INVALID_APPROVAL_FIELDS");
  if (kind === "AgentGrant" && message.parentId !== ROOT) throw Error("OWNER_APPROVAL_REQUIRES_ROOT");
  const lines = [`RingTree owner approval v${OWNER_APPROVAL_VERSION}`, "Network: Base Sepolia (84532)", `Broker instance: ${approvalDomain.salt}`, `Permission: ${kind}`, purposes[kind]];
  for (const field of fields) {
    if (field.name === "expiresAt") {
      const expiry = message.expiresAt;
      if (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry <= 0) throw Error("INVALID_APPROVAL_EXPIRY");
      const label = kind === "AgentGrant" ? "Grant expires" : "Approval must be used before";
      lines.push(`${label}: ${new Date(expiry * 1000).toISOString()} (${expiry})`);
    } else lines.push(`${labels[field.name] ?? field.name}: ${printable(message[field.name])}`);
  }
  // Bind the complete schema as well as every displayed value, without signing only a hash.
  const cleanTypes = { [kind]: fields };
  lines.push(`Payload digest: ${TypedDataEncoder.hash(approvalDomain, cleanTypes, message)}`);
  const text = lines.join("\n");
  if (text.length > 3000) throw Error("APPROVAL_TOO_LONG");
  return text;
}

export function verifyOwnerApproval(salt: string, types: Record<string, TypedDataField[]>, message: Record<string, unknown>, signature: string) {
  return verifyMessage(ownerApprovalText(domain(salt), types, message), signature);
}
