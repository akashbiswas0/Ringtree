# Local broker with AWS agents

This is the active RingTree architecture. The trusted broker and official `wallet-cli ring` run locally. AWS runs only the orchestrator, Graph Agent, executor, and an in-memory relay.

## Start the system

1. Start the local broker:

   ```sh
   RINGTREE_PORT=4321 npm run setup -- serve
   ```

2. Start the SSM tunnel in another terminal:

   ```sh
   npm run aws -- relay-tunnel
   ```

3. Start the connector in a third terminal:

   ```sh
   npm run connect:aws
   ```

4. Open `http://localhost:4321`, connect Ledger Flex, and sign a fresh 30-minute root grant.

5. Submit a Graph mission. Verify a live Subgraph answer, x402 status, and the separate `0.01 USDC` reward approval.

## Trust boundary

- AWS agents are on an internal Docker network and can call only the relay.
- The relay accepts `state`, `manifests`, `grants`, and `call`; owner and transaction routes are blocked.
- The connector authenticates with a random local token and forwards requests over an AWS SSM loopback tunnel.
- Every forwarded agent action still needs valid agent and host signatures and passes local scope, expiry, quota, nonce, and revocation checks.
- The relay has no provider keys, Key Ring files, wallet password, broker database, or Ledger access.

If the broker, tunnel, or connector stops, agents fail closed. In-flight payment work is not automatically replayed because a payment may already have settled.

## Deployment

```sh
npm run aws -- deploy-relay
npm run aws -- result COMMAND_ID
```

The deployed image intentionally excludes `wallet-cli`, Linux keychain services, broker storage, and provider credentials. The former AWS-broker files are not part of the active application.
