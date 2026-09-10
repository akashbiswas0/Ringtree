import { describe, expect, it, vi } from "vitest";
import { Wallet } from "ethers";
import {
  X402_GRAPH_ENDPOINT,
  X402GraphPayments,
} from "../server/x402";
import type { SecretProvider } from "../server/secrets";

const provider = (ready: boolean): SecretProvider => ({
  ready: () => ready,
  unlocked: () => ready,
  withSecret: async (fn) => fn(Wallet.createRandom().privateKey),
});

describe("x402 Graph payment guard", () => {
  it("uses The Graph's live Base Sepolia x402 gateway", () => {
    expect(X402_GRAPH_ENDPOINT).toContain("gateway.testnet.thegraph.com/api/x402");
    expect(X402_GRAPH_ENDPOINT).toContain(
      "69kQZiehpuHGMjYwzV5qZQUn75nZRH1ewn5nM4WzoZEv",
    );
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
    const result = await client.query();
    expect(result.status).toBe("unfunded");
    expect(result.balanceUnits).toBe("0");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("stays disabled without a Key Ring-protected payment key", async () => {
    const client = new X402GraphPayments(
      provider(false),
      Wallet.createRandom().address,
    );
    expect((await client.query()).status).toBe("disabled");
  });
});
