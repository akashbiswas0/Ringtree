import {
  DeviceManagementKitBuilder,
  DeviceActionStatus,
  DeviceStatus,
  DeviceSessionStateType,
  OpenAppDeviceAction,
  CloseAppCommand,
  isSuccessCommandResult,
  type DeviceManagementKit,
  type ExecuteDeviceActionReturnType,
} from "@ledgerhq/device-management-kit";
import {
  webHidTransportFactory,
  webHidIdentifier,
} from "@ledgerhq/device-transport-kit-web-hid";
import {
  SignerEthBuilder,
  SignTransactionDAStep,
  type SignerEth,
  type TypedData,
} from "@ledgerhq/device-signer-kit-ethereum";
import { firstValueFrom, filter, map, tap, timeout, take, type Subscription } from "rxjs";
import { Signature, getBytes, verifyMessage } from "ethers";
import { ownerApprovalText } from "../shared/owner-approval";
import { DERIVATION_PATH } from "../shared/protocol";
import { graphRewardDetails } from "../shared/payment";

export class LedgerController {
  private dmk?: DeviceManagementKit;
  private session?: string;
  private signer?: SignerEth;
  private busy = false;
  private connectionMonitor?: Subscription;
  address?: string;
  constructor(private status: (s: string) => void, private onDisconnect?: () => void) {}
  private async action<T, E, I>(
    action: ExecuteDeviceActionReturnType<T, E, I>,
  ): Promise<T> {
    try {
      return await firstValueFrom(
        action.observable.pipe(
          tap((s) => {
            if (s.status === DeviceActionStatus.Pending) {
              if ((s.intermediateValue as { step?: string }).step === SignTransactionDAStep.BLIND_SIGN_TRANSACTION_FALLBACK) {
                throw new Error("Blind-signing fallback blocked. Reject the request on Flex; no signature will be submitted.");
              }
              const i = (
                s.intermediateValue as { requiredUserInteraction?: string }
              ).requiredUserInteraction;
              const text: Record<string, string> = {
                "sign-personal-message": "Read the full RingTree permission on Flex. Reject any blind-signing or hash-only screen.",
                "confirm-open-app": "Approve opening Ethereum on Flex.",
                "verify-address": "Verify the address on your Ledger screen.",
                "sign-typed-data":
                  "Review and sign the permission on Ledger Flex.",
                "sign-transaction":
                  "Review the exact transaction on Ledger Flex.",
                "unlock-device": "Unlock your Ledger Flex.",
              };
              if (i && text[i]) this.status(text[i]);
            }
          }),
          filter(
            (s) =>
              s.status === DeviceActionStatus.Completed ||
              s.status === DeviceActionStatus.Error ||
              s.status === DeviceActionStatus.Stopped,
          ),
          map((s) => {
            if (s.status === DeviceActionStatus.Completed) return s.output;
            if (s.status === DeviceActionStatus.Error) throw s.error;
            throw new Error("Action stopped.");
          }),
          timeout(120000),
        ),
      );
    } catch (e) {
      action.cancel();
      throw e;
    }
  }
  private async ready() {
    if (!this.dmk || !this.session)
      throw new Error("Connect your Ledger first.");
    let state = await firstValueFrom(
      this.dmk.getDeviceSessionState({ sessionId: this.session }).pipe(take(1)),
    );
    if (state.deviceStatus === DeviceStatus.BUSY) {
      state = await firstValueFrom(
        this.dmk.getDeviceSessionState({ sessionId: this.session }).pipe(
          filter((s) => s.deviceStatus !== DeviceStatus.BUSY),
          timeout(10000),
          take(1),
        ),
      );
    }
    if (state.deviceStatus === DeviceStatus.LOCKED)
      throw new Error("Unlock Ledger Flex, then try again.");
    if (state.deviceStatus === DeviceStatus.NOT_CONNECTED) {
      this.session = undefined;
      this.signer = undefined;
      this.address = undefined;
      this.onDisconnect?.();
      throw new Error("Ledger disconnected. Reconnect it.");
    }
    if (
      state.sessionStateType !== DeviceSessionStateType.Connected &&
      state.currentApp.name !== "Ethereum"
    ) {
      if (!["BOLOS", "Dashboard"].includes(state.currentApp.name)) {
        const result = await this.dmk.sendCommand({
          sessionId: this.session,
          command: new CloseAppCommand(),
        });
        if (!isSuccessCommandResult(result)) throw result.error;
      }
      await this.action(
        this.dmk.executeDeviceAction({
          sessionId: this.session,
          deviceAction: new OpenAppDeviceAction({
            input: { appName: "Ethereum", unlockTimeout: 120000 },
          }),
        }),
      );
    }
  }
  async connect() {
    if (this.busy) throw new Error("A Ledger operation is already running.");
    this.busy = true;
    try {
      if (!("hid" in navigator))
        throw new Error("Use desktop Chrome or Edge with USB/WebHID.");
      this.dmk ??= new DeviceManagementKitBuilder()
        .addTransport(webHidTransportFactory)
        .build();
      if (!this.session) {
        this.status("Click the Flex row in the device picker, then Connect.");
        const device = await firstValueFrom(
          this.dmk
            .startDiscovering({ transport: webHidIdentifier })
            .pipe(timeout(60000)),
        );
        this.session = await this.dmk.connect({
          device,
          sessionRefresherOptions: { isRefresherDisabled: false },
        });
      }
      this.connectionMonitor?.unsubscribe();
      this.connectionMonitor = this.dmk.getDeviceSessionState({ sessionId: this.session }).subscribe({
        next: (state) => {
          if (state.deviceStatus === DeviceStatus.NOT_CONNECTED) {
            this.address = undefined;
            this.session = undefined;
            this.signer = undefined;
            this.onDisconnect?.();
            this.status("Ledger disconnected. Reconnect to continue.");
          }
        },
        error: () => {
          this.address = undefined;
          this.session = undefined;
          this.signer = undefined;
          this.onDisconnect?.();
          this.status("Ledger connection lost. Reconnect to continue.");
        },
      });
      await this.ready();
      this.signer = new SignerEthBuilder({
        dmk: this.dmk,
        sessionId: this.session,
        originToken: import.meta.env.VITE_LEDGER_ORIGIN_TOKEN || undefined,
      }).build();
      const result = await this.action(
        this.signer.getAddress(DERIVATION_PATH, { checkOnDevice: true }),
      );
      this.address = result.address;
      this.status("Address verified on Ledger.");
      return result.address;
    } catch (e) {
      await this.disconnect();
      throw e;
    } finally {
      this.busy = false;
    }
  }
  async signPermission(data: TypedData) {
    if (this.busy) throw new Error("A Ledger operation is already running.");
    this.busy = true;
    try {
      if (Object.keys(data.types).filter(k => k !== "EIP712Domain").join() !== data.primaryType) throw new Error("INVALID_APPROVAL_TYPE");
      const text = ownerApprovalText(data.domain, data.types, data.message);
      await this.ready();
      if (!this.signer) throw new Error("Connect Ledger first.");
      const sig = await this.action(
        this.signer.signMessage(DERIVATION_PATH, text),
      );
      const signature = Signature.from(sig).serialized;
      if (verifyMessage(text, signature) !== this.address) throw new Error("Recovered signer mismatch.");
      return signature;
    } finally {
      this.busy = false;
    }
  }
  async signTransaction(raw: string, paymentAddress?: string) {
    if (this.busy) throw new Error("A Ledger operation is already running.");
    this.busy = true;
    try {
      await this.ready();
      if (!this.signer) throw new Error("Connect Ledger first.");
      if (!paymentAddress)
        throw new Error("Graph Agent payment address is not configured.");
      const { tx } = graphRewardDetails(raw, paymentAddress);
      const sig = await this.action(
        this.signer.signTransaction(
          DERIVATION_PATH,
          getBytes(tx.unsignedSerialized),
        ),
      );
      tx.signature = Signature.from(sig);
      if (tx.from !== this.address)
        throw new Error("Recovered signer mismatch.");
      return tx.serialized;
    } finally {
      this.busy = false;
    }
  }
  async disconnect() {
    this.connectionMonitor?.unsubscribe();
    this.connectionMonitor = undefined;
    this.onDisconnect?.();
    if (this.session)
      await this.dmk?.disconnect({ sessionId: this.session }).catch(() => {});
    this.session = undefined;
    this.signer = undefined;
    this.address = undefined;
  }
}
export function deviceError(error: unknown) {
  const e = error as {
    _tag?: string;
    errorCode?: string;
    originalError?: { errorCode?: string };
    message?: string;
  };
  const code = e?.errorCode ?? e?.originalError?.errorCode;
  if (
    e?._tag === "RefusedByUserDAError" ||
    ["5501", "6985", "6982"].includes(code ?? "")
  )
    return "Cancelled on Ledger. You can try again when ready.";
  if (code === "6807")
    return "Install the Ethereum app through Ledger Wallet, then reconnect.";
  if (code === "6a80")
    return "Ledger could not display this payload. Reject it; do not enable blind signing. Check the Ethereum app version before retrying.";
  if (e?.message === "REPLAY")
    return "This transaction matched an older signature and was blocked. RingTree must prepare a fresh transaction before you sign again.";
  return (
    e?.message ?? "Ledger operation failed. Reconnect the device and try again."
  );
}
