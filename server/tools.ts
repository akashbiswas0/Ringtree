import { z } from "zod";
import { JsonRpcProvider, Transaction, parseUnits } from "ethers";
import type { SecretProvider } from "./secrets";
import type { GraphAgent } from "./graph-agent";
import { CHAIN_ID } from "../shared/protocol";
import {
  BASE_SEPOLIA_USDC,
  GRAPH_REWARD_UNITS,
  erc20,
  graphRewardCalldata,
} from "../shared/payment";

export const inputSchemas = {
  "tx.prepare": z
    .object({ missionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
    .strict(),
  "graph.answer": z
    .object({
      missionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      question: z.string().trim().min(8).max(600),
    })
    .strict(),
};
export interface ToolProvider {
  execute(tool: string, input: Record<string, unknown>): Promise<unknown>;
  prepare(
    intentId?: string,
    input?: Record<string, unknown>,
  ): Promise<string>;
  graphStatus?: () => { configured: boolean; ready: boolean };
  paymentStatus?: () => {
    configured: boolean;
    ready: boolean;
    address?: string;
  };
}
export function intentFeeJitter(intentId: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(intentId))
    throw new Error("INVALID_INTENT_ID");
  // At most 1,048,576 wei (0.001048576 gwei): economically negligible,
  // but enough entropy to prevent two proposals from producing identical txs.
  return BigInt(`0x${intentId.slice(-5)}`) + 1n;
}
export class LiveTools implements ToolProvider {
  provider = new JsonRpcProvider("https://sepolia.base.org", undefined, {
    batchMaxCount: 1,
  });
  constructor(
    private owner: string,
    private graphAgent?: GraphAgent,
    private paymentAddress?: string,
    private paymentSecret?: SecretProvider,
  ) {}
  async prepare(intentId?: string, input: Record<string, unknown> = {}) {
    if (!input.missionId) throw new Error("REWARD_MISSION_REQUIRED");
    if (!this.paymentAddress) throw new Error("PAYMENT_WALLET_NOT_CONFIGURED");
    const network = await this.provider.getNetwork();
    if (Number(network.chainId) !== CHAIN_ID) throw new Error("CHAIN_MISMATCH");
    const calldata = graphRewardCalldata(this.paymentAddress);
    const [nonce, fees, code, balanceResult] = await Promise.all([
      this.provider.getTransactionCount(this.owner, "pending"),
      this.provider.getFeeData(),
      this.provider.getCode(this.owner),
      this.provider.call({
        to: BASE_SEPOLIA_USDC,
        data: erc20.encodeFunctionData("balanceOf", [this.owner]),
      }),
    ]);
    if (code !== "0x") throw new Error("GRAPH_REWARD_REQUIRES_EOA");
    const balance = BigInt(erc20.decodeFunctionResult("balanceOf", balanceResult)[0]);
    if (balance < GRAPH_REWARD_UNITS)
      throw new Error("INSUFFICIENT_TEST_USDC");
    const priority = fees.maxPriorityFeePerGas ?? parseUnits("0.001", "gwei");
    const max = fees.maxFeePerGas ?? priority * 2n;
    const jitter = intentFeeJitter(intentId ?? `0x${"0".repeat(64)}`);
    const adjustedPriority = priority + jitter;
    const adjustedMax = (max < priority ? priority : max) + jitter;
    if (adjustedMax > parseUnits("10", "gwei"))
      throw new Error("FEE_CAP_EXCEEDED");
    const gas = await this.provider.estimateGas({
      from: this.owner,
      to: BASE_SEPOLIA_USDC,
      value: 0n,
      data: calldata,
    });
    return Transaction.from({
      type: 2,
      chainId: CHAIN_ID,
      to: BASE_SEPOLIA_USDC,
      value: 0n,
      data: calldata,
      nonce,
      gasLimit: (gas * 12n) / 10n,
      maxFeePerGas: adjustedMax,
      maxPriorityFeePerGas: adjustedPriority,
    }).unsignedSerialized;
  }
  async execute(tool: string, input: Record<string, unknown>) {
    if (tool === "graph.answer") {
      if (!this.graphAgent) throw new Error("GRAPH_AGENT_UNAVAILABLE");
      return this.graphAgent.answer(
        String(input.question),
        String(input.missionId),
      );
    }
    throw new Error("TOOL_DENIED");
  }
  graphStatus() {
    return this.graphAgent?.status() ?? { configured: false, ready: false };
  }
  paymentStatus() {
    return {
      configured: Boolean(this.paymentAddress && this.paymentSecret?.ready()),
      ready: Boolean(this.paymentAddress && this.paymentSecret?.unlocked()),
      address: this.paymentAddress,
    };
  }
}
