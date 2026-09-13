import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from "@x402/core/http";
import { wrapFetchWithPayment as createPaidFetch } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "ethers";
import type { SecretProvider } from "./secrets";
import type { Store } from "./store";
import {
  BASE_SEPOLIA_USDC,
  X402_DAILY_BUDGET_UNITS,
  X402_MAX_PAYMENT_UNITS,
  erc20,
} from "../shared/payment";
import { digest } from "../shared/protocol";

export const X402_GRAPH_SUBGRAPH_ID =
  "9M3Rm1qzEFgwyVUbAETPFdmJzEgvA6Ey1KPNt11zDr2t";
export const X402_GRAPH_ENDPOINT =
  `https://gateway.testnet.thegraph.com/api/x402/subgraphs/id/${X402_GRAPH_SUBGRAPH_ID}`;
export const X402_GRAPH_QUERY = `{
  _meta { block { number timestamp } hasIndexingErrors }
  usdcactivity(id: "global") {
    totalTransferCount
    totalVolume
    lastBlock
    lastTimestamp
  }
  transfers(first: 5, orderBy: blockNumber, orderDirection: desc) {
    from
    to
    amount
    blockNumber
    blockTimestamp
    transactionHash
  }
}`;

export type X402QueryResult = {
  status:
    | "disabled"
    | "unfunded"
    | "paid"
    | "failed"
    | "budget-exhausted"
    | "duplicate-blocked";
  endpoint: string;
  subgraphId: string;
  queryHash: string;
  dailyBudgetUnits: string;
  dailySpentUnits?: string;
  balanceUnits?: string;
  paidAmountUnits?: string;
  paymentHash?: string;
  blockNumber?: number;
  blockTimestamp?: number;
  freshnessSeconds?: number;
  reason?: string;
  reused?: boolean;
  data?: unknown;
};

type StoredPayment = {
  missionId: string;
  day: string;
  status: "inflight" | "paid" | "failed";
  createdAt: string;
  paidAmountUnits?: string;
  result?: X402QueryResult;
};

const baseResult = (): Pick<
  X402QueryResult,
  "endpoint" | "subgraphId" | "queryHash" | "dailyBudgetUnits"
> => ({
  endpoint: X402_GRAPH_ENDPOINT,
  subgraphId: X402_GRAPH_SUBGRAPH_ID,
  queryHash: digest({ query: X402_GRAPH_QUERY }),
  dailyBudgetUnits: X402_DAILY_BUDGET_UNITS.toString(),
});

export function validateX402Settlement(
  header: string | null,
  expectedPayer: string,
  expectedAmount: string,
) {
  if (!header) throw new Error("X402_SETTLEMENT_REQUIRED");
  const settlement = decodePaymentResponseHeader(header);
  const amount = settlement?.amount ?? expectedAmount;
  const transaction = settlement?.transaction;
  let payerMatches = false;
  try {
    payerMatches =
      typeof settlement?.payer === "string" &&
      getAddress(settlement.payer) === getAddress(expectedPayer);
  } catch {
    payerMatches = false;
  }
  if (
    settlement?.success !== true ||
    settlement?.network !== "eip155:84532" ||
    !payerMatches ||
    typeof amount !== "string" ||
    !/^\d+$/.test(amount) ||
    BigInt(amount) <= 0n ||
    BigInt(amount) > X402_MAX_PAYMENT_UNITS ||
    typeof transaction !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(transaction)
  )
    throw new Error("X402_SETTLEMENT_INVALID");
  return { amount, transaction };
}

export function validateX402Requirement(header: string | null) {
  if (!header) throw new Error("X402_REQUIREMENT_REQUIRED");
  const required = decodePaymentRequiredHeader(header);
  const accepted = required.accepts.filter((option) => {
    try {
      return (
        option.scheme === "exact" &&
        option.network === "eip155:84532" &&
        getAddress(option.asset) === BASE_SEPOLIA_USDC &&
        /^\d+$/.test(option.amount) &&
        BigInt(option.amount) > 0n &&
        BigInt(option.amount) <= X402_MAX_PAYMENT_UNITS &&
        Boolean(getAddress(option.payTo))
      );
    } catch {
      return false;
    }
  });
  if (accepted.length !== 1) throw new Error("X402_REQUIREMENT_INVALID");
  return { amount: accepted[0].amount, payTo: getAddress(accepted[0].payTo) };
}

export class X402GraphPayments {
  constructor(
    private secret: SecretProvider,
    private address: string | undefined,
    private fetcher: typeof fetch = fetch,
    private store?: Store,
    private clock: () => Date = () => new Date(),
  ) {}

  status() {
    return {
      configured: Boolean(this.address && this.secret.ready()),
      ready: Boolean(this.address && this.secret.unlocked()),
      address: this.address,
    };
  }

  private payments() {
    return this.store?.all<StoredPayment>("x402-payment") ?? [];
  }

  private spent(day: string) {
    return this.payments()
      .filter((payment) => payment.day === day)
      .reduce(
        (total, payment) =>
          total +
          (payment.status === "paid"
            ? BigInt(payment.paidAmountUnits ?? "0")
            : payment.status === "inflight"
              ? X402_MAX_PAYMENT_UNITS
              : 0n),
        0n,
      );
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

  async query(missionId: string): Promise<X402QueryResult> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(missionId))
      throw new Error("X402_MISSION_REQUIRED");
    const common = baseResult();
    if (!this.status().ready) return { status: "disabled", ...common };

    const existing = this.store?.get<StoredPayment>("x402-payment", missionId);
    if (existing?.status === "paid" && existing.result)
      return { ...existing.result, reused: true };
    if (existing)
      return {
        status: "duplicate-blocked",
        ...common,
        reason: "A prior payment attempt exists for this mission.",
      };

    const createdAt = this.clock().toISOString();
    const day = createdAt.slice(0, 10);
    const preliminarySpent = this.spent(day);
    if (
      preliminarySpent + X402_MAX_PAYMENT_UNITS >
      X402_DAILY_BUDGET_UNITS
    )
      return {
        status: "budget-exhausted",
        ...common,
        dailySpentUnits: preliminarySpent.toString(),
        reason: "The daily Graph payment budget is exhausted.",
      };
    const balance = await this.balance();
    if (balance === 0n)
      return {
        status: "unfunded",
        ...common,
        dailySpentUnits: this.spent(day).toString(),
        balanceUnits: "0",
      };
    let spent = 0n;
    if (this.store) {
      const reservation = this.store.atomic(() => {
        const concurrent = this.store!.get<StoredPayment>(
          "x402-payment",
          missionId,
        );
        if (concurrent) return { kind: "duplicate" as const, concurrent };
        const currentSpent = this.spent(day);
        if (
          currentSpent + X402_MAX_PAYMENT_UNITS >
          X402_DAILY_BUDGET_UNITS
        )
          return { kind: "budget" as const, spent: currentSpent };
        this.store!.put("x402-payment", missionId, {
          missionId,
          day,
          status: "inflight",
          createdAt,
        } satisfies StoredPayment);
        return { kind: "reserved" as const, spent: currentSpent };
      });
      if (reservation.kind === "duplicate") {
        if (
          reservation.concurrent.status === "paid" &&
          reservation.concurrent.result
        )
          return { ...reservation.concurrent.result, reused: true };
        return {
          status: "duplicate-blocked",
          ...common,
          reason: "A concurrent payment attempt exists for this mission.",
        };
      }
      if (reservation.kind === "budget")
        return {
          status: "budget-exhausted",
          ...common,
          dailySpentUnits: reservation.spent.toString(),
          reason: "The daily Graph payment budget is exhausted.",
        };
      spent = reservation.spent;
    }
    try {
      const paid = await this.secret.withSecret(async (privateKey) => {
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
                maxAmountPerPayment: X402_MAX_PAYMENT_UNITS.toString(),
              },
            ],
          },
        });
        let requiredAmount: string | undefined;
        const inspectingFetch: typeof fetch = async (input, init) => {
          const response = await this.fetcher(input, init);
          if (response.status === 402) {
            const requirement = validateX402Requirement(
              response.headers.get("payment-required") ??
                response.headers.get("x-payment-required"),
            );
            requiredAmount = requirement.amount;
          }
          return response;
        };
        const paidFetch = createPaidFetch(inspectingFetch, client);
        const response = await paidFetch(X402_GRAPH_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: X402_GRAPH_QUERY }),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error("X402_QUERY_FAILED");
        const result = (await response.json()) as {
          data?: {
            _meta?: {
              block?: { number?: number; timestamp?: number };
              hasIndexingErrors?: boolean;
            };
            usdcactivity?: { totalTransferCount?: string; totalVolume?: string };
          };
          errors?: unknown[];
        };
        if (
          result.errors?.length ||
          result.data?._meta?.hasIndexingErrors ||
          typeof result.data?._meta?.block?.number !== "number" ||
          typeof result.data._meta.block.timestamp !== "number" ||
          !result.data?.usdcactivity?.totalTransferCount ||
          !result.data.usdcactivity.totalVolume
        )
          throw new Error("X402_QUERY_INVALID");
        const freshnessSeconds = Math.abs(
          Math.floor(this.clock().getTime() / 1000) -
            result.data._meta.block.timestamp,
        );
        if (freshnessSeconds > 900) throw new Error("X402_QUERY_STALE");
        const settlement = validateX402Settlement(
          response.headers.get("payment-response") ??
            response.headers.get("x-payment-response"),
          account.address,
          requiredAmount ?? "",
        );
        return { settlement, data: result.data, freshnessSeconds };
      });
      const result: X402QueryResult = {
        status: "paid",
        ...common,
        dailySpentUnits: (spent + BigInt(paid.settlement.amount)).toString(),
        balanceUnits: balance.toString(),
        paidAmountUnits: paid.settlement.amount,
        paymentHash: paid.settlement.transaction,
        blockNumber: paid.data._meta!.block!.number,
        blockTimestamp: paid.data._meta!.block!.timestamp,
        freshnessSeconds: paid.freshnessSeconds,
        data: paid.data,
      };
      this.store?.put("x402-payment", missionId, {
        missionId,
        day,
        status: "paid",
        createdAt,
        paidAmountUnits: paid.settlement.amount,
        result,
      } satisfies StoredPayment);
      this.store?.event("X402_PAID", {
        missionId,
        amountUnits: paid.settlement.amount,
        paymentHash: paid.settlement.transaction,
        subgraphId: X402_GRAPH_SUBGRAPH_ID,
        queryHash: common.queryHash,
      });
      return result;
    } catch {
      this.store?.put("x402-payment", missionId, {
        missionId,
        day,
        status: "failed",
        createdAt,
      } satisfies StoredPayment);
      return {
        status: "failed",
        ...common,
        dailySpentUnits: spent.toString(),
        balanceUnits: balance.toString(),
        reason: "The paid Graph query or settlement verification failed.",
      };
    }
  }
}
