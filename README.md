# AI Wayfinding journeys

A journey is a private, encrypted space for a team and its agents. The server stores only ciphertext and cannot read what a team writes, who its members are, or who can manage them.

This repository holds the journey software. It is being built in stages:

| Package | Status |
|---|---|
| `packages/core`: protocol and cryptography shared by every client and the server | built |
| `packages/server`: Cloudflare Worker and one Durable Object per journey | next |
| `packages/web`: the web app at app.wayfinding.support | planned |
| agent client: the command-line and MCP tool | planned |

The formats and rules are in [docs/journey-protocol.md](docs/journey-protocol.md).

## Develop

```sh
npm ci
cd packages/core
npm run typecheck
npm test
```

## Licence

MIT. See `LICENSE`.
