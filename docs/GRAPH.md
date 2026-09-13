# Graph Agent

The Graph Agent is one scoped agent inside RingTree. It turns a natural-language question into a verified live-data report without receiving the OpenAI or Graph Gateway keys.

## Load-bearing Graph workflow

Every successful mission must:

1. Query the RingTree `ledger-agent` Subgraph for cumulative and deterministic 24-hour Base Sepolia USDC evidence.
2. Discover a relevant active Subgraph through The Graph Subgraph MCP.
3. Check its 30-day query activity.
4. Inspect the matching schema.
5. Execute one live query per explicitly named external protocol.
6. Prefer standardized lending, DEX, or yield snapshots for DeFi comparisons.
7. Return a short analysis with exact query evidence, sources, units, risk indicators, confidence, and time-window limitations.

The broker rejects incomplete MCP sequences. The agent cannot substitute another MCP endpoint or send an arbitrary GraphQL URL.

For Aave V3 and Morpho Blue comparisons on Base, the broker supplies verified core-contract hints from the official [Aave address book](https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Base.sol) and [Morpho address registry](https://docs.morpho.org/developers/contracts/addresses/). MCP uses `get_top_subgraph_deployments` for both contracts, checks every candidate's 30-day activity, and refuses to compare the protocols unless two focused live queries use distinct identifiers.

## First-party Subgraph

- Studio: `https://thegraph.com/studio/subgraph/ledger-agent`
- Query endpoint: `https://api.studio.thegraph.com/query/95022/ledger-agent/v0.0.3`
- Studio version: `v0.0.3`
- Deployment: `QmcUD1krkpDUd7a7vhG3sr4LiFt5Ze3aTc9CP1i6ExN435`
- Published RingTree testnet Subgraph ID: `9M3Rm1qzEFgwyVUbAETPFdmJzEgvA6Ey1KPNt11zDr2t`
- Network indexed: Base Sepolia
- Contract: Circle testnet USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- Observation start: block `46600000`
- Entities: `Transfer`, `Account`, `USDCActivity`, `USDCActivityHour`, and `USDCActivityDay`

Hourly and daily snapshots record transfer count, volume, maximum transfer, transfers of at least 10,000 USDC, and whale transfers of at least 100,000 USDC. The broker calculates current and previous 24-hour windows using integer arithmetic. The aggregates describe this observation window, not lifetime USDC activity.

Studio `v0.0.3` is deployed, synchronized, and pinned by the broker for the enhanced hourly/day analysis. The existing testnet Subgraph ID remains the x402 data source using its compatible `USDCActivity` and `Transfer` fields. Arbitrum One mainnet publication is not required for the Graph AI track. The broker also rejects first-party data more than 15 minutes behind wall-clock time.

## x402

Before the AI analysis, the local broker pays The Graph's testnet x402 gateway to query real Shinkai identity and delegation data from allocated Subgraph `69kQ…ZoZEv`. The payer private key is encrypted under the `ringtree-agent-payment` Key Ring name. RingTree's own published testnet Subgraph currently has no signal or Indexer allocation, so it remains a Studio data source rather than a paid gateway target.

Controls are fixed in code:

- network: Base Sepolia (`eip155:84532`);
- asset: official Base Sepolia USDC;
- query: `_meta`, `ShinkaiIdentity`, and `Delegation` entities from the allocated paid Subgraph;
- maximum payment: `0.02 USDC`; and
- daily payment ceiling: `0.10 USDC`;
- one durable payment record per mission; and
- endpoint: The Graph testnet x402 URL for allocated Subgraph ID `69kQ…ZoZEv`.

Mission output records the exact Subgraph ID, query hash, daily spend, paid amount, and verified settlement transaction. A mission cannot automatically pay twice; an uncertain prior attempt fails closed.

## Verifiable MCP evidence

For every MCP call, RingTree records the tool status and hashes of its arguments and output. Query calls also retain the exact GraphQL query and Subgraph/deployment identifier. Raw provider output is not duplicated into the audit database. When an inspected schema contains Messari version fields and standard snapshot entities, the dashboard labels it as a standardized DeFi source.

## Build and publish

```sh
npm run graph:codegen
npm run graph:build
npm run graph:test
npm run graph:deploy
```

The Graph deploy key and runtime Gateway API key are different credentials and must not be committed.

Do not publish this test project to Arbitrum One mainnet merely to update the Studio version. Subgraph Studio provides the enhanced live dataset, while the already-published Graph testnet Subgraph provides the x402 path.

## Limits

- The model sees the user's question and relevant live Graph results.
- One capability call may make several MCP queries, so the RingTree call quota is not an exact provider-spend quota.
- Cross-protocol arithmetic beyond the first-party USDC windows is explained by the model and must remain traceable to the displayed MCP queries and output hashes.
- The report is evidence-backed analysis, not investment advice or transaction authorization.
