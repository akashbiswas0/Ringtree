# Local broker with AWS agents

Migration status: implementation prepared; live cutover requires verification of
the current local broker and a broker-state snapshot. The AWS broker remains the
active production configuration until `deploy-relay` is explicitly run.

The laptop runs the broker and official wallet-cli. AWS runs the existing Graph
Agent, orchestrator and executor plus a credential-free HTTP relay. Graph/AI
provider calls and x402 signing execute locally. The relay holds requests only
in memory, exposes no owner routes and requires a separate random connector token.
AWS credentials authenticate the SSM tunnel; agent calls retain their existing
signed grants, host signature, expiry and replay checks.

## Cutover checklist

1. Pause AWS agents and snapshot the AWS broker SQLite database. Preserve its
   signatures, nonce history, mission/reward history and salt when transferring
   the snapshot into a dedicated local data directory. Back up the existing local
   database first; do not merge grants or reset nonce tables.
2. Confirm the local encrypted OpenAI, Graph and payment files match the intended
   wallet and use the local CLI profile. No VPS member/private credential is needed.
3. Build with `npm run build`. Stop the old local broker and run
   `npm run setup -- serve`, entering the existing local Key Ring password in its
   hidden terminal prompt. Verify `ringReady`, `graphReady`, and `paymentReady`.
4. Run `npm run aws -- deploy-relay`. This builds and deploys the relay and agents,
   with no broker secret/keychain mounts and no provider egress. Check its SSM
   result before proceeding. The old AWS state files are retained for rollback.
5. Run `npm run aws -- relay-tunnel` in one terminal and `npm run connect:aws`
   in another. During this migration the local dashboard is
   http://localhost:4321; after retiring the old local process it can return to
   the default port 4318.
6. Sign a fresh root grant locally, submit one Graph mission, verify sources and
   x402 receipt, and review the reward separately on Ledger.
7. Disconnect the connector and verify agent requests stop; reconnect and verify
   recovery. A lost in-flight job is not replayed automatically because a payment
   may already have settled. Review any running mission before retrying.

Do not run the legacy `aws upload` command after cutover: it deploys the VPS
broker. Use `deploy-relay` for this architecture. Legacy RingLink scripts are
retained only for rollback during migration and are not part of local setup.

## Cleanup after verification

Retiring the AWS broker does not remove its existing Key Ring membership or
erase old ciphertext/keychain backups. Those are a separate operator action:
removing a member can rotate the ring and require re-encrypting credentials.
Until cleanup is verified, do not claim that the laptop is the only machine
capable of decrypting the old ciphertext.

The laptop must be awake, connected, and running the broker and connector.
This architecture demonstrates scoped agent access to CLI-protected secrets;
it does not enroll AWS into Key Ring.
