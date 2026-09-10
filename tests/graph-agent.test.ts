import { describe, expect, it, vi } from "vitest";
import { GraphAgent } from "../server/graph-agent";
import type { SecretProvider } from "../server/secrets";

const secret = (value: string): SecretProvider => ({
  ready: () => true,
  unlocked: () => true,
  withSecret: async (fn) => fn(value),
});

describe("Graph Agent remote MCP enforcement", () => {
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
    );
    const result = await agent.answer("Compare live Uniswap activity.");
    expect(result.live).toBe(true);
    expect(result.source).toBe("The Graph Subgraph MCP");
    expect(result.text).toContain("Live Graph evidence");
    expect(result.customSubgraph.blockNumber).toBe(46610000);
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
      const calls = [
        { type: "mcp_call", name: "search_subgraphs_by_keyword", status: "completed" },
        { type: "mcp_call", name: "get_deployment_30day_query_counts", status: "completed" },
        { type: "mcp_call", name: "get_schema_by_deployment_id", status: "completed" },
      ];
      if (openAiCalls === 2)
        calls.push({
          type: "mcp_call",
          name: "execute_query_by_deployment_id",
          status: "completed",
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
    const result = await agent.answer("Compare a live deployment.");
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
    await expect(agent.answer("Tell me about Uniswap activity.")).rejects.toThrow(
      "GRAPH_LIVE_QUERY_REQUIRED",
    );
  });
});
