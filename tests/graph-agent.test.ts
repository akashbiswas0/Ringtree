import { describe, expect, it, vi } from "vitest";
import {
  GraphAgent,
  isFocusedGraphQuery,
  max30DayQueryCount,
  requestedDefiProtocols,
  summarizeActivityWindows,
} from "../server/graph-agent";
import type { SecretProvider } from "../server/secrets";
import type { X402GraphPayments } from "../server/x402";

const secret = (value: string): SecretProvider => ({
  ready: () => true,
  unlocked: () => true,
  withSecret: async (fn) => fn(value),
});
const missionId = `0x${"1".repeat(64)}`;

describe("Graph Agent remote MCP enforcement", () => {
  it("calculates matching 24-hour USDC windows without floating-point math", () => {
    const buckets = Array.from({ length: 48 }, (_, index) => ({
      timestamp: String(1_800_000_000 - index * 3600),
      transferCount: "1",
      volume: "1000000",
      maxTransfer: "1000000",
      largeTransferCount: "0",
      whaleTransferCount: "0",
      whaleVolume: "0",
    }));
    const windows = summarizeActivityWindows(buckets);
    expect(windows?.latest24Hours.transferCount).toBe("24");
    expect(windows?.latest24Hours.volumeUsdc).toBe("24");
    expect(windows?.previous24Hours.volumeUsdc).toBe("24");
    expect(windows?.volumeChangePercent).toBe("0.00");
  });

  it("detects explicit multi-protocol DeFi comparisons", () => {
    expect(
      requestedDefiProtocols("Compare Aave and Morpho lending markets"),
    ).toEqual(["aave", "morpho"]);
    expect(requestedDefiProtocols("Summarize Base USDC activity")).toEqual([]);
  });

  it("distinguishes metadata checks from data-bearing queries", () => {
    expect(isFocusedGraphQuery("{ _meta { block { number timestamp } } }")).toBe(
      false,
    );
    expect(
      isFocusedGraphQuery("{ markets(first: 5) { id totalValueLockedUSD } }"),
    ).toBe(true);
  });

  it("derives the highest verified 30-day deployment activity", () => {
    expect(
      max30DayQueryCount(
        '{"deployments":[{"total_query_count":0},{"total_query_count":4200}]}',
      ),
    ).toBe(4200n);
    expect(max30DayQueryCount('{"deployments":[]}')).toBeUndefined();
  });

  it("returns an answer only after activity verification and a live query", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("api.studio.thegraph.com"))
        return new Response(
          JSON.stringify({
            data: {
              _meta: {
                block: { number: 46610000, timestamp: 1789000000 },
                hasIndexingErrors: false,
              },
              usdcactivity: {
                totalTransferCount: "42",
                totalVolume: "9000000",
                lastBlock: "46610000",
                lastTimestamp: "1789000000",
              },
              transfers: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const body = JSON.parse(String(init?.body));
      expect(body.store).toBe(false);
      expect(body.tools[0].server_url).toBe(
        "https://subgraphs.mcp.thegraph.com/sse",
      );
      expect(body.tools[0].headers.Authorization).toBe("Bearer graph-test-key-1234");
      expect(body.tools[0].allowed_tools).not.toContain("unknown_tool");
      expect(body.tools[0].allowed_tools).toContain("get_schema_by_deployment_id");
      expect(body.tools[0].allowed_tools).toContain("execute_query_by_deployment_id");
      expect(body.max_output_tokens).toBeGreaterThan(1000);
      expect(body.max_tool_calls).toBe(16);
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "mcp_call",
              name: "search_subgraphs_by_keyword",
              status: "completed",
            },
            {
              type: "mcp_call",
              name: "get_deployment_30day_query_counts",
              status: "completed",
              output: '{"deployments":[{"total_query_count":123}]}',
            },
            {
              type: "mcp_call",
              name: "get_schema_by_subgraph_id",
              status: "completed",
              output:
                "type Protocol { schemaVersion: String! methodologyVersion: String! } type MarketDailySnapshot { id: ID! }",
            },
            {
              type: "mcp_call",
              name: "execute_query_by_subgraph_id",
              status: "completed",
              arguments: JSON.stringify({
                subgraph_id: "verified-subgraph-id",
                query: "{ pools(first: 1) { id } }",
              }),
              output: JSON.stringify({ data: { _meta: { block: { number: 1 } } } }),
            },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Live Graph evidence supports the answer.",
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const agent = new GraphAgent(
      secret("sk-test-only"),
      secret("graph-test-key-1234"),
      "test-model",
      fetcher,
      undefined,
      () => 1789000100,
    );
    const result = await agent.answer("Compare live Uniswap activity.", missionId);
    expect(result.live).toBe(true);
    expect(result.source).toBe("The Graph Subgraph MCP");
    expect(result.analysisMode).toBe("standardized-defi");
    expect(result.text).toContain("Live Graph evidence");
    expect(result.customSubgraph.blockNumber).toBe(46610000);
    expect(result.mcpCalls[1].max30DayQueryCount).toBe("123");
    expect(result.mcpCalls.at(-1)).toMatchObject({
      identifier: "verified-subgraph-id",
      query: "{ pools(first: 1) { id } }",
      outputBytes: expect.any(Number),
    });
    expect(result.mcpCalls.at(-1)?.outputHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries one incomplete MCP sequence and then returns verified live data", async () => {
    let openAiCalls = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("api.studio.thegraph.com"))
        return new Response(
          JSON.stringify({
            data: {
              _meta: {
                block: { number: 46610000 },
                hasIndexingErrors: false,
              },
              usdcactivity: {
                totalTransferCount: "42",
                totalVolume: "9000000",
              },
              transfers: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      openAiCalls++;
      const calls: Array<{
        type: string;
        name: string;
        status: string;
        arguments?: string;
        output?: string;
      }> = [
        { type: "mcp_call", name: "search_subgraphs_by_keyword", status: "completed" },
        {
          type: "mcp_call",
          name: "get_deployment_30day_query_counts",
          status: "completed",
          output: '{"deployments":[{"total_query_count":123}]}',
        },
        { type: "mcp_call", name: "get_schema_by_deployment_id", status: "completed" },
      ];
      if (openAiCalls === 2)
        calls.push({
          type: "mcp_call",
          name: "execute_query_by_deployment_id",
          status: "completed",
          arguments: JSON.stringify({
            deployment_id: "verified-deployment",
            query: "{ markets(first: 1) { id } }",
          }),
        });
      return new Response(
        JSON.stringify({
          status: openAiCalls === 1 ? "incomplete" : "completed",
          incomplete_details:
            openAiCalls === 1 ? { reason: "max_output_tokens" } : undefined,
          output: [
            ...calls,
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Verified deployment data.",
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const agent = new GraphAgent(
      secret("sk-test-only"),
      secret("graph-test-key-1234"),
      "test-model",
      fetcher,
    );
    const result = await agent.answer("Compare a live deployment.", missionId);
    expect(result.text).toBe("Verified deployment data.");
    expect(openAiCalls).toBe(2);
  });

  it("rejects a model answer that did not execute a live query", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      new Response(
        String(url).includes("api.studio.thegraph.com")
          ? JSON.stringify({
              data: {
                _meta: {
                  block: { number: 46610000 },
                  hasIndexingErrors: false,
                },
                usdcactivity: {
                  totalTransferCount: "42",
                  totalVolume: "9000000",
                },
                transfers: [],
              },
            })
          :
        JSON.stringify({
          output: [
            {
              type: "mcp_call",
              name: "search_subgraphs_by_keyword",
              status: "completed",
            },
            {
              type: "mcp_call",
              name: "get_deployment_30day_query_counts",
              status: "completed",
              output: '{"deployments":[{"total_query_count":123}]}',
            },
            {
              type: "mcp_call",
              name: "get_schema_by_subgraph_id",
              status: "completed",
            },
            {
              type: "message",
              content: [{ type: "output_text", text: "Unsupported answer" }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;
    const agent = new GraphAgent(
      secret("sk-test-only"),
      secret("graph-test-key-1234"),
      "test-model",
      fetcher,
    );
    await expect(
      agent.answer("Tell me about Uniswap activity.", missionId),
    ).rejects.toThrow(
      "GRAPH_LIVE_QUERY_REQUIRED",
    );
  });

  it("rejects an explicit two-protocol comparison backed by one source", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      new Response(
        String(url).includes("api.studio.thegraph.com")
          ? JSON.stringify({
              data: {
                _meta: {
                  block: { number: 46610000 },
                  hasIndexingErrors: false,
                },
                usdcactivity: {
                  totalTransferCount: "42",
                  totalVolume: "9000000",
                },
                transfers: [],
              },
            })
          : JSON.stringify({
              output: [
                {
                  type: "mcp_call",
                  name: "search_subgraphs_by_keyword",
                  status: "completed",
                },
                {
                  type: "mcp_call",
                  name: "get_deployment_30day_query_counts",
                  status: "completed",
                  output: '{"deployments":[{"total_query_count":123}]}',
                },
                {
                  type: "mcp_call",
                  name: "get_schema_by_subgraph_id",
                  status: "completed",
                },
                {
                  type: "mcp_call",
                  name: "execute_query_by_subgraph_id",
                  status: "completed",
                  arguments: JSON.stringify({
                    subgraph_id: "only-one-source",
                    query: "{ markets(first: 1) { id } }",
                  }),
                },
                {
                  type: "message",
                  content: [{ type: "output_text", text: "One source only" }],
                },
              ],
            }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;
    const agent = new GraphAgent(
      secret("sk-test-only"),
      secret("graph-test-key-1234"),
      "test-model",
      fetcher,
    );
    await expect(
      agent.answer("Compare Aave and Morpho lending markets.", missionId),
    ).rejects.toThrow("GRAPH_COMPARISON_REQUIRES_TWO_LIVE_SOURCES");
  });

  it("does not spend x402 budget while the first-party Subgraph is syncing", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            _meta: {
              block: { number: 46610000, timestamp: 1000 },
              hasIndexingErrors: false,
            },
            usdcactivity: {
              totalTransferCount: "42",
              totalVolume: "9000000",
            },
            transfers: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;
    const paymentQuery = vi.fn();
    const agent = new GraphAgent(
      secret("sk-test-only"),
      secret("graph-test-key-1234"),
      "test-model",
      fetcher,
      { query: paymentQuery } as unknown as X402GraphPayments,
      () => 2000,
    );
    await expect(
      agent.answer("Summarize live Base activity.", missionId),
    ).rejects.toThrow("RINGTREE_SUBGRAPH_SYNCING");
    expect(paymentQuery).not.toHaveBeenCalled();
  });
});
