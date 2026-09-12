# ETHOnline demo script

**0:00–0:25 — Problem**

“Cloud agents need paid APIs and blockchain data, but raw keys on a VPS can leak. RingTree keeps secrets and policy in a local Ledger-backed broker while AWS agents receive only scoped capabilities.”

**0:25–0:55 — Architecture**

Show the local `wallet-cli ring` broker, SSM tunnel, credential-free AWS relay, and three isolated agents. Do not display passwords, decrypted values, environment dumps, or keychain files.

**0:55–1:25 — Ledger authority**

Connect Flex. Show and sign the readable host/root permission, including tools, expiry, and shared call budget.

**1:25–2:10 — Live Graph work**

Ask: “Summarize recent Base Sepolia USDC activity and compare a matching metric from another active Subgraph.” Show first-party Subgraph data, MCP discovery, usage check, schema inspection, live query, and the normalized answer.

**2:10–2:40 — Agent payment**

Show `x402: paid` and its settlement hash. Then review the distinct `0.01 USDC` reward recipient and amount on Flex and broadcast it.

**2:40–3:00 — Fail closed**

Revoke the root grant and show the next agent request denied. End on the audit log: “Ledger approves the boundary; agents work inside it.”
