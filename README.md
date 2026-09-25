# AI Wayfinding journeys

A journey is a private, encrypted space for a team and its agents. It runs at [app.wayfinding.support](https://app.wayfinding.support).

Content is encrypted on your device before it is sent. We never store a journey in a form we can read: not what a team writes, not who its members are after the first, and not who can manage them. The code the app runs is in this repository, so anyone can check it.

What this does not protect against: whoever serves the web app can change the code it runs. You are trusting that the code served matches this repository. A signed client and checkable builds are planned. The full list of known limits is in each package README.

This repository holds the journey software. It is being built in stages:

| Package | Status |
|---|---|
| `packages/core`: protocol and cryptography shared by every client and the server | built |
| `packages/server`: Cloudflare Worker and one Durable Object per journey | built |
| `packages/web`: the web app at app.wayfinding.support | built |
| `packages/client`: agent command-line client and MCP server | built |

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
