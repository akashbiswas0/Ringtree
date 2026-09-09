import { Interface, Transaction, getAddress } from "ethers";

export const BASE_SEPOLIA_USDC = getAddress(
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
);
export const GRAPH_REWARD_UNITS = 10_000n;
export const GRAPH_REWARD_LABEL = "0.01 USDC";

export const erc20 = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

export function graphRewardCalldata(paymentAddress: string) {
  return erc20.encodeFunctionData("transfer", [
    getAddress(paymentAddress),
    GRAPH_REWARD_UNITS,
  ]);
}

export function graphRewardDetails(raw: string, paymentAddress: string) {
  const tx = Transaction.from(raw);
  if (
    tx.chainId !== 84532n ||
    tx.to !== BASE_SEPOLIA_USDC ||
    tx.value !== 0n
  )
    throw new Error("INVALID_GRAPH_REWARD");
  const decoded = erc20.decodeFunctionData("transfer", tx.data);
  const recipient = getAddress(String(decoded[0]));
  const amount = BigInt(decoded[1]);
  if (
    recipient !== getAddress(paymentAddress) ||
    amount !== GRAPH_REWARD_UNITS
  )
    throw new Error("INVALID_GRAPH_REWARD");
  return { tx, recipient, amount };
}
