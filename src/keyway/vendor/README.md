# Vendored Keyway TS SDK

In-tree copy of the Keyway TypeScript SDK, vendored from the
`codex/keyway-ts-sdk` branch of `DeconBear/keyway` (MIT, same author) so the
embedded Keyway runtime works out of the box with zero external packages and
no Python sidecar.

- `core/` — headless routing, credential, and quota contracts
  (`@keyway-router/core` upstream)
- `gateway/` — authenticated loopback OpenAI/Anthropic gateway
  (`@keyway-router/gateway` upstream)
- `node/` — Node.js SQLite store and secret-store adapters
  (`@keyway-router/node` upstream)

Boundary rules:

- This directory must stay dependency-free (Node built-ins only) and must not
  import anything outside `src/keyway/vendor/` — it is vendored upstream code,
  not Hadamard-authored surface.
- Hadamard code consumes it only through the ports in `src/keyway/keywayPorts.ts`
  and the loaders in `embeddedKeyway.ts` / `keywayLoopbackGateway.ts`.
- The contract guards (`KEYWAY_CONTRACT_VERSION`, `KEYWAY_GATEWAY_VERSION`)
  must be bumped in lockstep with any incompatible vendored change.
- Tests live in `tests/keyway-vendor-*.spec.ts` with fixtures under
  `tests/fixtures/keyway/`.

Upstream sync note: the standalone Keyway product (Python gateway, desktop
packaging) remains in `DeconBear/keyway`; only the TS SDK is vendored here.
