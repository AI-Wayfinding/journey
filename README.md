# AI Wayfinding journeys

A journey is a private, encrypted space for a team and its agents. The server stores only ciphertext and cannot read what a team writes, who its members are, or who can manage them.

This repository holds the journey software. It is being built in stages:

| Package | Status |
|---|---|
| `packages/core`: protocol and cryptography shared by every client and the server | built |
| `packages/server`: Cloudflare Worker and one Durable Object per journey | built |
| `packages/web`: the web app at app.wayfinding.support | built |
| agent client: the command-line and MCP tool | planned |

The formats and rules are in [docs/journey-protocol.md](docs/journey-protocol.md).

## Develop

```sh
npm ci
npm run build -w @ai-wayfinding/core
npm run typecheck -w @ai-wayfinding/core
npm run test -w @ai-wayfinding/core
npm run typecheck -w @ai-wayfinding/server
npm run test -w @ai-wayfinding/server
npm run typecheck -w @ai-wayfinding/web
npm run test -w @ai-wayfinding/web
npm run build -w @ai-wayfinding/web
npm run test:e2e -w @ai-wayfinding/web
```

The [web package README](packages/web/README.md) explains passkeys, the local Worker test, and the limits of key recovery.

```sh
# This builds a local deploy preview; it does not deploy.
cd packages/server
npx wrangler deploy --dry-run --outdir ../../.scratch/wrangler-dry-run
```

## Licence

MIT. See `LICENSE`.
