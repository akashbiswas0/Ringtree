import { describe, expect, it } from "vitest";
import { Transaction, Wallet } from "ethers";
import {
  BASE_SEPOLIA_USDC,
  GRAPH_REWARD_UNITS,
  graphRewardCalldata,
  graphRewardDetails,
} from "../shared/payment";

describe("fixed Graph Agent reward", () => {
  it("binds the official token, separate recipient, and exact reward amount", () => {
    const payment = Wallet.createRandom().address;
    const raw = Transaction.from({
      type: 2,
      chainId: 84532,
      to: BASE_SEPOLIA_USDC,
      value: 0n,
      data: graphRewardCalldata(payment),
      gasLimit: 65000n,
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1n,
    }).unsignedSerialized;
    const details = graphRewardDetails(raw, payment);
    expect(details.recipient).toBe(payment);
    expect(details.amount).toBe(GRAPH_REWARD_UNITS);
    expect(() => graphRewardDetails(raw, Wallet.createRandom().address)).toThrow(
      "INVALID_GRAPH_REWARD",
    );
  });
});
