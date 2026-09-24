# Agent guide

This repository builds AI Wayfinding journeys. "Enclave" is the technical term used in code; "journey" is the word people see.

- `packages/core` is the protocol and crypto core. It must run unchanged in Node, browsers and Cloudflare Workers: Web Crypto only, no `node:` imports in `src/`.
- Read [docs/journey-protocol.md](docs/journey-protocol.md) before changing any format or rule.
- Changes to formats must stay additive, or add a new type version with a converter.
- Done means `npm run typecheck` and `npm test` pass in the package you changed, run after your last edit.
