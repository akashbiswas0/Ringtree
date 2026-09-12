# Graph Agent

The Graph Agent is one scoped agent inside RingTree. It turns a natural-language question into a verified live-data report without receiving the OpenAI or Graph Gateway keys.

## Load-bearing Graph workflow

Every successful mission must:

1. Query the RingTree `ledger-agent` Subgraph for current Base Sepolia USDC evidence.
2. Discover a relevant active Subgraph through The Graph Subgraph MCP.
3. Check its 30-day query activity.
4. Inspect the matching schema.
5. Execute a live query.
6. Return a short analysis with sources, units, time-window limitations, and MCP evidence.

The broker rejects incomplete MCP sequences. The agent cannot substitute another MCP endpoint or send an arbitrary GraphQL URL.

## First-party Subgraph

- Studio: `https://thegraph.com/studio/subgraph/ledger-agent`
- Query endpoint: `https://api.studio.thegraph.com/query/95022/ledger-agent/version/latest`
- Network indexed: Base Sepolia
- Contract: Circle testnet USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- Observation start: block `46600000`
- Entities: `Transfer`, `Account`, and `USDCActivity`

The aggregates describe this observation window, not lifetime USDC activity.

## x402

Before the AI analysis, the local broker attempts one fixed query to The Graph testnet x402 gateway. The payer private key is encrypted under the `ringtree-agent-payment` Key Ring name.

Controls are fixed in code:

- network: Base Sepolia (`eip155:84532`);
- asset: official Base Sepolia USDC;
- query: Subgraph `_meta` only;
- maximum payment: `0.02 USDC`; and
- endpoint: the configured The Graph testnet x402 Subgraph URL.

Mission output records `disabled`, `unfunded`, `paid`, or `failed`, plus the settlement transaction when supplied by the gateway.

## Build and publish

```sh
npm run graph:codegen
npm run graph:build
npm run graph:test
npm run graph:deploy
```

The Graph deploy key and runtime Gateway API key are different credentials and must not be committed.

## Limits

- The model sees the user's question and relevant live Graph results.
- One capability call may make several MCP queries, so the RingTree call quota is not an exact provider-spend quota.
- The report is evidence-backed analysis, not investment advice or transaction authorization.
