import { describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import {
  X402_GRAPH_ENDPOINT,
  X402_GRAPH_QUERY,
  X402_GRAPH_SUBGRAPH_ID,
  X402GraphPayments,
  validateX402Requirement,
  validateX402Settlement,
} from "../server/x402";
import { X402_DAILY_BUDGET_UNITS } from "../shared/payment";
import type { SecretProvider } from "../server/secrets";
import { Store } from "../server/store";

const provider = (ready: boolean): SecretProvider => ({
  ready: () => ready,
  unlocked: () => ready,
  withSecret: async (fn) => fn(Wallet.createRandom().privateKey),
});
const mission = (digit: string) => `0x${digit.repeat(64)}`;

describe("x402 Graph payment guard", () => {
  it("uses The Graph's live Base Sepolia x402 gateway", () => {
    expect(X402_GRAPH_ENDPOINT).toContain("gateway.testnet.thegraph.com/api/x402");
    expect(X402_GRAPH_ENDPOINT).toContain(
      X402_GRAPH_SUBGRAPH_ID,
    );
    expect(X402_GRAPH_SUBGRAPH_ID).toBe(
      "69kQZiehpuHGMjYwzV5qZQUn75nZRH1ewn5nM4WzoZEv",
    );
    expect(X402_GRAPH_QUERY).toContain("shinkaiIdentities");
    expect(X402_GRAPH_QUERY).toContain("delegations(");
  });
  it("does not attempt payment before the reward wallet is funded", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ result: "0x" + "0".repeat(64) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof fetch;
    const client = new X402GraphPayments(
      provider(true),
      Wallet.createRandom().address,
      fetcher,
    );
    const result = await client.query(mission("1"));
    expect(result.status).toBe("unfunded");
    expect(result.balanceUnits).toBe("0");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("stays disabled without a Key Ring-protected payment key", async () => {
    const client = new X402GraphPayments(
      provider(false),
      Wallet.createRandom().address,
    );
    expect((await client.query(mission("2"))).status).toBe("disabled");
  });

  it("enforces a durable daily spend ceiling before provider I/O", async () => {
    const store = new Store(":memory:");
    store.put("x402-payment", mission("3"), {
      missionId: mission("3"),
      day: "2026-09-13",
      status: "paid",
      createdAt: "2026-09-13T00:00:00.000Z",
      paidAmountUnits: "90000",
    });
    const fetcher = vi.fn() as unknown as typeof fetch;
    const client = new X402GraphPayments(
      provider(true),
      Wallet.createRandom().address,
      fetcher,
      store,
      () => new Date("2026-09-13T12:00:00.000Z"),
    );
    const result = await client.query(mission("4"));
    expect(result.status).toBe("budget-exhausted");
    expect(result.dailyBudgetUnits).toBe(X402_DAILY_BUDGET_UNITS.toString());
    expect(result.dailySpentUnits).toBe("90000");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reuses a verified receipt instead of paying twice for one mission", async () => {
    const store = new Store(":memory:");
    const missionId = mission("5");
    const result = {
      status: "paid" as const,
      endpoint: X402_GRAPH_ENDPOINT,
      subgraphId: X402_GRAPH_SUBGRAPH_ID,
      queryHash: mission("6"),
      dailyBudgetUnits: X402_DAILY_BUDGET_UNITS.toString(),
      paidAmountUnits: "42",
      paymentHash: mission("7"),
    };
    store.put("x402-payment", missionId, {
      missionId,
      day: "2026-09-13",
      status: "paid",
      createdAt: "2026-09-13T00:00:00.000Z",
      paidAmountUnits: "42",
      result,
    });
    const fetcher = vi.fn() as unknown as typeof fetch;
    const client = new X402GraphPayments(
      provider(true),
      Wallet.createRandom().address,
      fetcher,
      store,
    );
    expect(await client.query(missionId)).toEqual({ ...result, reused: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("opens a circuit after a paid-resource failure", async () => {
    const store = new Store(":memory:");
    store.put("x402-payment", mission("8"), {
      missionId: mission("8"),
      day: "2026-09-13",
      status: "failed",
      createdAt: "2026-09-13T12:00:00.000Z",
      subgraphId: X402_GRAPH_SUBGRAPH_ID,
      reason: "X402_QUERY_FAILED",
    });
    const fetcher = vi.fn() as unknown as typeof fetch;
    const client = new X402GraphPayments(
      provider(true),
      Wallet.createRandom().address,
      fetcher,
      store,
      () => new Date("2026-09-13T12:05:00.000Z"),
    );
    const result = await client.query(mission("9"));
    expect(result.status).toBe("circuit-open");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates the paid amount and transaction receipt header", () => {
    const transaction = `0x${"a".repeat(64)}`;
    const payer = Wallet.createRandom().address;
    const header = Buffer.from(
      JSON.stringify({
        success: true,
        network: "eip155:84532",
        payer,
        transaction,
      }),
    ).toString("base64");
    expect(validateX402Settlement(header, payer, "42")).toEqual({
      amount: "42",
      transaction,
    });
    expect(() => validateX402Settlement(null, payer, "42")).toThrow(
      "X402_SETTLEMENT_REQUIRED",
    );
    expect(() =>
      validateX402Settlement(
        header,
        Wallet.createRandom().address,
        "42",
      ),
    ).toThrow("X402_SETTLEMENT_INVALID");
  });

  it("accepts only one capped Base Sepolia USDC payment offer", () => {
    const payTo = Wallet.createRandom().address;
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: { url: X402_GRAPH_ENDPOINT },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532",
            amount: "42",
            payTo,
            maxTimeoutSeconds: 300,
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            extra: { name: "USDC", version: "2" },
          },
        ],
      }),
    ).toString("base64");
    expect(validateX402Requirement(header)).toEqual({ amount: "42", payTo });
    expect(() => validateX402Requirement(null)).toThrow(
      "X402_REQUIREMENT_REQUIRED",
    );
  });
});
