import { it, expect, vi } from "vitest";
import { of } from "rxjs";
import { Wallet, Signature, Transaction, hexlify, randomBytes } from "ethers";
import { SignTransactionDAStep } from "@ledgerhq/device-signer-kit-ethereum";
import { DeviceActionStatus, DeviceStatus, DeviceSessionStateType } from "@ledgerhq/device-management-kit";
import { LedgerController } from "../src/ledger";
import { domain, hostTypes } from "../shared/protocol";
import { ownerApprovalText } from "../shared/owner-approval";
import {
  BASE_SEPOLIA_USDC,
  GRAPH_REWARD_UNITS,
  graphRewardCalldata,
} from "../shared/payment";

// Test-only transport substitute. Production always uses Ledger DMK/WebHID.
function fixture() {
  const w = Wallet.createRandom();
  const data = { domain: domain(hexlify(randomBytes(32))), types: structuredClone(hostTypes), primaryType: "HostEnrollment", message: { hostId: w.address, label: "Test host", action: "enroll", expiresAt: 1900000000, nonce: hexlify(randomBytes(32)) } };
  const signMessage = vi.fn(), signTypedData = vi.fn(), cancel = vi.fn();
  const c = new LedgerController(vi.fn());
  Object.assign(c, { address: w.address, session: "test-only", signer: { signMessage, signTypedData }, dmk: { getDeviceSessionState: () => of({ deviceStatus: DeviceStatus.CONNECTED, sessionStateType: DeviceSessionStateType.ReadyWithoutSecureChannel, currentApp: { name: "Ethereum" } }) } });
  return { c, w, data, signMessage, signTypedData, cancel };
}
it("sends full readable text to signMessage and verifies the returned owner", async () => {
  const f = fixture();
  const text = ownerApprovalText(f.data.domain, f.data.types, f.data.message);
  const sig = await f.w.signMessage(text);
  f.signMessage.mockReturnValue({ observable: of({ status: DeviceActionStatus.Completed, output: Signature.from(sig) }), cancel: f.cancel });
  expect(await f.c.signPermission(f.data)).toBe(sig);
  expect(f.signMessage).toHaveBeenCalledWith("44'/60'/0'/0/0", text);
  expect(f.signTypedData).not.toHaveBeenCalled();
});
it("does not retry a device rejection or fall back to typed-data signing", async () => {
  const f = fixture();
  f.signMessage.mockReturnValue({ observable: of({ status: DeviceActionStatus.Error, error: { errorCode: "6985" } }), cancel: f.cancel });
  await expect(f.c.signPermission(f.data)).rejects.toEqual({ errorCode: "6985" });
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.signMessage).toHaveBeenCalledOnce();
  expect(f.signTypedData).not.toHaveBeenCalled();
});
it("rejects invalid permissions before sending them to hardware", async () => {
  const f = fixture();
  await expect(f.c.signPermission({ ...f.data, domain: { ...f.data.domain, name: "Other" } })).rejects.toThrow("INVALID_APPROVAL_DOMAIN");
  expect(f.signMessage).not.toHaveBeenCalled();
});
it("rejects signatures from a different wallet", async () => {
  const f = fixture();
  const sig = await Wallet.createRandom().signMessage(ownerApprovalText(f.data.domain, f.data.types, f.data.message));
  f.signMessage.mockReturnValue({ observable: of({ status: DeviceActionStatus.Completed, output: Signature.from(sig) }), cancel: f.cancel });
  await expect(f.c.signPermission(f.data)).rejects.toThrow("Recovered signer mismatch");
});
it("cancels and discards a transaction signature on the SDK blind fallback path", async () => {
  const f = fixture();
  const payment = Wallet.createRandom().address;
  const raw = Transaction.from({ type: 2, chainId: 84532, to: BASE_SEPOLIA_USDC, value: 0n, data: graphRewardCalldata(payment), gasLimit: 65000n, maxFeePerGas: 1000n, maxPriorityFeePerGas: 1n }).unsignedSerialized;
  const signed = Transaction.from(await f.w.signTransaction(Transaction.from(raw)));
  const signTransaction = vi.fn(() => ({ observable: of(
    { status: DeviceActionStatus.Pending, intermediateValue: { step: SignTransactionDAStep.BLIND_SIGN_TRANSACTION_FALLBACK } },
    { status: DeviceActionStatus.Completed, output: signed.signature },
  ), cancel: f.cancel }));
  Object.assign(f.c, { signer: { signTransaction } });
  await expect(f.c.signTransaction(raw, payment)).rejects.toThrow("Blind-signing fallback blocked");
  expect(f.cancel).toHaveBeenCalledOnce();
});
it("rejects changed Graph Agent reward recipients and amounts before hardware signing", async () => {
  const f = fixture();
  const payment = Wallet.createRandom().address;
  const attacker = Wallet.createRandom().address;
  const wrongRecipient = Transaction.from({ type: 2, chainId: 84532, to: BASE_SEPOLIA_USDC, value: 0n, data: graphRewardCalldata(attacker), gasLimit: 65000n, maxFeePerGas: 1000n, maxPriorityFeePerGas: 1n }).unsignedSerialized;
  await expect(f.c.signTransaction(wrongRecipient, payment)).rejects.toThrow("INVALID_GRAPH_REWARD");
  expect(GRAPH_REWARD_UNITS).toBe(10000n);
});
