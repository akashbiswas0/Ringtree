# Ledger Agent Stack developer feedback

RingTree uses Ledger Flex, DMK/WebHID, the Ethereum signer, and the official `wallet-cli ring` CLI. The final architecture keeps Key Ring and the broker local while credential-free agents run on AWS.

## What worked well

- DMK cleanly separates device transport/session handling from Ethereum signing.
- `signMessage` supports readable, versioned permission approvals containing scope, expiry, nonce, and broker identity.
- `wallet-cli ring encrypt/decrypt` is a small, scriptable boundary for API and payment credentials.
- Named Key Ring entries make it practical to separate OpenAI, Graph, and agent-payment secrets.

## Friction and suggested improvements

### Password input

Shell environment variables are easy to leak through history or process inspection. Add first-class `--password-stdin` or OS-keychain reference support and a documented password-change flow.

### Headless/no-USB guidance

The track highlights VPS and CI hosts, but the public CLI flow is much clearer for a USB-connected local machine than for safely extending Key Ring to a no-USB host. Publish an official, end-to-end VPS/CI architecture with precise membership, revocation, and rotation guarantees.

### Capability-broker reference

Key Ring membership is a broad decryption boundary, while an agent capability should be narrow and revocable. A reference broker showing “credential stays here; agent receives only an allowed result” would prevent teams from conflating these layers.

### Device-display guarantees

Software can detect some fallback states but cannot prove what the user saw on the physical screen. Document what DMK can assert, what must be visually verified, and the recommended fail-closed behavior for blind or hash-only displays.

### Version compatibility

DMK, signer kits, context modules, and `wallet-cli` evolve independently. Publish a tested Agent Stack compatibility matrix with known-good combinations and breaking changes.

### Diagnostics

A non-secret `wallet-cli ring doctor` command could check profile selection, Key Ring reachability, password validity, local keychain support, and backend status without exposing plaintext.
