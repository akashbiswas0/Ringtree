import { it, expect } from "vitest";
import {
  Wallet,
  hexlify,
  randomBytes,
  computeAddress,
  verifyMessage,
} from "ethers";
import { sdk } from "../scripts/lkrp";
import {
  JoinApproval,
  joinMessage,
  approvalMessage,
  joinTypes,
} from "../shared/enrollment";
import { canonical, domain } from "../shared/protocol";
import { ownerApprovalText, verifyOwnerApproval } from "../shared/owner-approval";
it("uses real SDK member credentials and binds enrollment to the specific trustchain", async () => {
  const member = await sdk().initMemberCredentials();
  const remote = new Wallet("0x" + member.privatekey);
  const owner = Wallet.createRandom();
  const salt = hexlify(randomBytes(32));
  expect(remote.address).toBe(computeAddress("0x" + member.pubkey));
  const request = {
    memberPubkey: member.pubkey,
    name: "test remote",
    nonce: hexlify(randomBytes(32)),
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    proof: "",
  };
  request.proof = await remote.signMessage(canonical(joinMessage(request)));
  expect(verifyMessage(canonical(joinMessage(request)), request.proof)).toBe(
    remote.address,
  );
  const bundle = {
    request,
    rootId: "test-root",
    applicationPath: "m/17'/0'",
    salt,
    owner: owner.address,
    signature: "",
  };
  bundle.signature = await owner.signMessage(ownerApprovalText(
    domain(salt),
    joinTypes,
    approvalMessage(bundle),
  ));
  expect(JoinApproval.parse(bundle)).toEqual(bundle);
  expect(
    verifyOwnerApproval(
      salt,
      joinTypes,
      approvalMessage(bundle),
      bundle.signature,
    ),
  ).toBe(owner.address);
  expect(
    verifyOwnerApproval(
      salt,
      joinTypes,
      approvalMessage({ ...bundle, rootId: "attacker-root" }),
      bundle.signature,
    ),
  ).not.toBe(owner.address);
});
