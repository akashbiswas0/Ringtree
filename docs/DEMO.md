# Demo checklist

## Three-minute story

1. Show the local broker status: all three encrypted credentials are present and unlocked through `wallet-cli ring`.
2. Show AWS has no inbound ports and contains only a credential-free relay plus three isolated agent identities.
3. Connect Ledger Flex, authorize the agent host if needed, and sign a readable 30-minute root grant.
4. Compare two DeFi protocols. Show deterministic 24-hour USDC metrics, standardized-schema detection, both exact MCP queries, output hashes, and a separate `x402: paid` query against an allocated Graph testnet Subgraph.
5. Review the separate `0.01 USDC` mission reward on Ledger and show its Base Sepolia transaction link.
6. Revoke the root grant and show that a new descendant call fails while the audit log records the denial.

## Evidence required before submission

- [ ] Record the physical Flex displaying the owner address, root grant, and exact reward transaction.
- [ ] Show `wallet-cli ring` encrypt/decrypt succeeds without printing any secret.
- [ ] Show agent containers have no credential, broker-state, or connector-token mounts.
- [ ] Show the AWS agent-state response excludes dashboard, payment-payload, and audit-log data.
- [ ] Show the relay rejects owner routes and stops working when the local connector is closed.
- [ ] Complete a fresh live Graph MCP mission with source and time-window evidence.
- [ ] Complete and link one Base Sepolia x402 settlement.
- [ ] Complete and link one `0.01 USDC` Graph Agent reward.
- [ ] Show root revocation blocks the Graph Agent or executor on its next request.
- [ ] Publish the repository and record a two-to-four-minute demo video.

Passing tests are supporting evidence, not a substitute for the physical-device and live-network recording.
