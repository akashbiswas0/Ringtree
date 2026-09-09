import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  decodePaymentResponseHeader,
  wrapFetchWithPayment,
} from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import type { SecretProvider } from "./secrets";
import { BASE_SEPOLIA_USDC, erc20 } from "../shared/payment";

export const X402_GRAPH_ENDPOINT =
  "https://gateway.testnet.thegraph.com/api/x402/subgraphs/id/69kQZiehpuHGMjYwzV5qZQUn75nZRH1ewn5nM4WzoZEv";
const query = "{ _meta { block { number timestamp } hasIndexingErrors } }";

export type X402QueryResult = {
  status: "disabled" | "unfunded" | "paid" | "failed";
  endpoint: string;
  balanceUnits?: string;
  paidAmountUnits?: string;
  paymentHash?: string;
  data?: unknown;
};

export class X402GraphPayments {
  constructor(
    private secret: SecretProvider,
    private address: string | undefined,
    private fetcher: typeof fetch = fetch,
  ) {}

  status() {
    return {
      configured: Boolean(this.address && this.secret.ready()),
      ready: Boolean(this.address && this.secret.unlocked()),
      address: this.address,
    };
  }

  private async balance() {
    if (!this.address) return 0n;
    const response = await this.fetcher("https://sepolia.base.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
          {
            to: BASE_SEPOLIA_USDC,
            data: erc20.encodeFunctionData("balanceOf", [this.address]),
          },
          "latest",
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("X402_BALANCE_UNAVAILABLE");
    const json = (await response.json()) as { result?: string };
    if (!json.result) throw new Error("X402_BALANCE_UNAVAILABLE");
    return BigInt(erc20.decodeFunctionResult("balanceOf", json.result)[0]);
  }

  async query(): Promise<X402QueryResult> {
    if (!this.status().ready)
      return { status: "disabled", endpoint: X402_GRAPH_ENDPOINT };
    const balance = await this.balance();
    if (balance < 10_000n)
      return {
        status: "unfunded",
        endpoint: X402_GRAPH_ENDPOINT,
        balanceUnits: balance.toString(),
      };
    try {
      return await this.secret.withSecret(async (privateKey) => {
        const account = privateKeyToAccount(privateKey as `0x${string}`);
        const client = x402Client.fromConfig({
          schemes: [
            {
              network: "eip155:84532",
              client: new ExactEvmScheme(account),
            },
          ],
          spendControls: {
            maxAmountPerPayment: "$0.02",
            allowedAssets: [
              {
                network: "eip155:84532",
                asset: BASE_SEPOLIA_USDC,
                maxAmountPerPayment: "20000",
              },
            ],
          },
        });
        const paidFetch = wrapFetchWithPayment(this.fetcher, client);
        const response = await paidFetch(X402_GRAPH_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error("X402_QUERY_FAILED");
        const result = (await response.json()) as { data?: unknown; errors?: unknown[] };
        if (result.errors?.length || !result.data)
          throw new Error("X402_QUERY_FAILED");
        const paymentHeader =
          response.headers.get("payment-response") ??
          response.headers.get("x-payment-response");
        const settlement = paymentHeader
          ? decodePaymentResponseHeader(paymentHeader)
          : undefined;
        return {
          status: "paid" as const,
          endpoint: X402_GRAPH_ENDPOINT,
          balanceUnits: balance.toString(),
          paidAmountUnits: settlement?.amount,
          paymentHash: settlement?.transaction,
          data: result.data,
        };
      });
    } catch {
      return {
        status: "failed",
        endpoint: X402_GRAPH_ENDPOINT,
        balanceUnits: balance.toString(),
      };
    }
  }
}
