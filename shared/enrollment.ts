import { z } from "zod";
import { Hash, SignatureSchema, Address } from "./protocol";
export const JoinRequest = z
  .object({
    memberPubkey: z.string().regex(/^[0-9a-f]{66}$/i),
    name: z.string().min(1).max(48),
    nonce: Hash,
    expiresAt: z.number().int().positive(),
    proof: SignatureSchema,
  })
  .strict();
export const joinTypes = {
  RingLinkEnrollment: [
    { name: "memberPubkey", type: "string" },
    { name: "name", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint256" },
    { name: "rootId", type: "string" },
    { name: "applicationPath", type: "string" },
  ],
};
export const JoinApproval = z
  .object({
    request: JoinRequest,
    owner: Address,
    salt: Hash,
    signature: SignatureSchema,
    rootId: z.string().min(1),
    applicationPath: z.string().min(1),
  })
  .strict();
export const JoinBundle = JoinApproval;
export const joinMessage = (r: z.infer<typeof JoinRequest>) => ({
  memberPubkey: r.memberPubkey,
  name: r.name,
  nonce: r.nonce,
  expiresAt: r.expiresAt,
});
export const approvalMessage = (a: z.infer<typeof JoinApproval>) => ({
  ...joinMessage(a.request),
  rootId: a.rootId,
  applicationPath: a.applicationPath,
});
