# Agent guide

This repository builds AI Wayfinding journeys. "Enclave" is the technical term used in code; "journey" is the word people see.

The repository is being rebuilt from a clean start. The rules pipeline and the MCP server shell exist; the coordination tools, the local proxy and the MCP Apps views arrive in later stages.

## Layout

- `packages/rules`: coordination rules written in gdp-wired.
  - `src/*.ts`: rule models, their laws, step laws and a broken variant per rule. `src/models.ts` lists every model that ships.
  - `generated/<name>.js` and `generated/<name>.d.ts`: standalone JavaScript made from each model with gdp-wired `compileJs`. Committed. Never edit by hand.
  - `rules.lock.json`: the gdp-wired version and integrity, and the SHA-256 of every generated file.
  - `scripts/build.ts` writes the generated files and the lock; `scripts/check.ts` regenerates them in memory and fails on any byte difference.
  - `test/*.test.ts`: `node:test` suites run with Node's built-in TypeScript type stripping.
- `packages/mcp`: the MCP server, a Cloudflare Worker built on the official `@modelcontextprotocol/server` (pinned exactly).
  - `src/worker.ts`: the Worker entry; reads `AUTHKIT_ISSUER` and `MCP_RESOURCE` from `wrangler.jsonc` vars.
  - `src/app.ts`: routing. OAuth metadata documents, then `/mcp` behind Host validation and `requireBearerAuth`, then `createMcpHandler` serving 2026-07-28 and 2025-era clients statelessly from one factory.
  - `src/auth.ts`: verifies WorkOS AuthKit access tokens with jose (issuer, `aud` equal to the resource, RS256, `exp`). The key lookup is injectable; tests sign with a local key pair.
  - `src/server.ts`: the per-request `McpServer` factory and its tools.
  - `test/*.test.ts`: drive the Worker's `fetch` in-process with the official `@modelcontextprotocol/client`. Name tests so `--test-name-pattern=auth` and `--test-name-pattern=era` select the auth and protocol-era cases.

## gdp-wired rules

- gdp-wired is pinned to exactly `0.31.1` in `packages/rules/package.json`: no caret, no tilde. A bump changes `package-lock.json` and `rules.lock.json`; rerun every proof, `crossCheck` and broken-variant test, and review the diff of the generated modules.
- Prove step laws with `proveSteps(rule, laws, stepLaws, {from: 'any'})` and require `proven && checked && !assumes`. Stored state is stepped from whatever is stored, so a proof that only covers states reachable from the start does not count.
- Never use `gate()` from `gdp-wired/gdp` on stored state: it proves reachable states only.
- Ship only the generated modules. Runtime code never calls `rule.compiled()`, `loadJs` or anything else that uses `new Function`; Workers and the Apps CSP refuse it. gdp-wired is for the build and the tests.
- Every rule keeps a broken variant next to it, and a test asserts the laws are refused for it.
- Every rule has a test that runs `crossCheck` and one that steps the generated module and the interpreter on the same random requests and compares the states.
- Every value a rule reads is a natural below 2^53. Encoders intern IDs to small integers and reject anything else before stepping; there is no bigint in rule state.
- Give each law a plain-language comment so a reviewer can read the set without reading gdp-wired.
- After changing a model, run `npm run build:rules` and commit the generated files and `rules.lock.json` with the model.

## Commands

Run from the repository root:

```sh
npm ci
npm run build:rules   # regenerate packages/rules/generated and rules.lock.json
npm run check:rules   # fail if the committed generated files are stale
npm run typecheck
npm test
```

For the MCP Worker, from the repository root:

```sh
npm run typecheck -w @ai-wayfinding/mcp   # Node and Workers type configs
npm test -w @ai-wayfinding/mcp
cd packages/mcp && npx wrangler deploy --dry-run --outdir /tmp/wayfinding-mcp-dry   # bundle only; never deploys
```

`npm run deploy -w @ai-wayfinding/mcp` deploys to Cloudflare; only the dispatching session deploys.

CI runs `npm ci`, `npm run check:rules`, `npm run typecheck` and `npm test` on Node 22.

## Done

A change is done when `npm run typecheck` and `npm test` pass at the repository root, and `npm run check:rules` passes, run after your last edit.

## Rules for code

- Code that must run in Node, browsers and Cloudflare Workers uses Web Crypto only and no `node:` imports outside build scripts and tests.
- Use exact versions of official SDKs and libraries.
- Parallelize independent work where possible.
