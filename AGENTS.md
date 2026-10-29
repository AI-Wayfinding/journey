# Agent guide

This repository builds AI Wayfinding journeys. "Enclave" is the technical term used in code; "journey" is the word people see.

The repository is being rebuilt from a clean start. The rules pipeline, coordination tools, MCP server, MCP Apps views, encrypted relay, task inboxes and local proxy exist.

## Layout

- `packages/rules`: coordination rules written in gdp-wired.
  - `src/*.ts`: rule models, their laws, step laws and a broken variant per rule. `src/models.ts` lists every model that ships.
  - `generated/<name>.js` and `generated/<name>.d.ts`: standalone JavaScript made from each model with gdp-wired `compileJs`. Committed. Never edit by hand.
  - `rules.lock.json`: the gdp-wired version and integrity, and the SHA-256 of every generated file.
  - `scripts/build.ts` writes the generated files and the lock; `scripts/check.ts` regenerates them in memory and fails on any byte difference.
  - `test/*.test.ts`: `node:test` suites run with Node's built-in TypeScript type stripping.
- `packages/apps`: self-contained MCP Apps views using `@modelcontextprotocol/ext-apps` 2.0.4.
  - `src/contract.ts` defines the allowlisted metadata boundary; artifact content and access URLs never enter a view.
  - `src/*.html`, `src/view.ts` and `src/style.css` build into `generated/views.ts`, imported by the Worker. No runtime filesystem or external view fetches.
  - Run `npm run build:apps` after editing a view, and commit the generated module. `npm run check:apps` checks bytes without writing; matching builds leave the file untouched. Root typecheck includes this check.
  - Keep every released versioned `ui://` URI in the resource registry when adding a successor.
  - MCP registration lives in `packages/mcp/src/apps.ts`. `apps_*` tools have visibility `["app"]`; visibility is a host hint, not authorization. All tools recheck backend authority.
  - Tests named `apps` load bundled HTML through the official SDK and execute its App with a spec postMessage host and DOM stand-in.
  - `/signin` redirects to the configured `AUTHKIT_AUTHORIZE_URL`; no redirect target comes from caller input.
- `packages/proxy`: the local stdio MCP server. Run `node packages/proxy/src/cli.ts --store DIR` from the root; default store is `~/.wayfinding`, loopback port is 8717 (`--port` overrides).
  - `src/mls`: replaceable `MlsGroup` implementation, ts-mls 1.6.4, unaudited. Synthetic data only.
  - `src/proxy.ts`: ordered MLS synchronization, per-artifact keys, personal artifacts and copy/move. `src/crypto.ts` uses Web Crypto AES-256-GCM with group/artifact/version authenticated data.
  - `src/oauth.ts`: SDK AuthKit DCR and PKCE; `src/cli.ts` receives the state-checked loopback callback and serves stdio. The sign-in URL and diagnostics use stderr.
  - `src/file-store.ts`: owned 0700 directory, 0600 atomic records, exclusive lock. Use one directory per device. After a crash, confirm the old process stopped before removing its stale lock. An ambiguous MLS post fails closed; do not restore an old ratchet snapshot.
  - Use `mls_group_create` once, `mls_group_prepare` on a joining device, then `mls_group_add` on an existing member with its authenticated person/device ids. Synchronization re-shares live history and removes departed journey leaves before sending new keys. No background daemon is required; a member proxy must synchronize after admission.
  - Tests named `proxy` exercise multiple clients against the in-process Worker, scan all server storage and blobs, and test fake-AS PKCE plus private local persistence.
- `packages/mcp`: the MCP server, a Cloudflare Worker built on the official `@modelcontextprotocol/server` (pinned exactly).
  - `src/worker.ts`: the Worker entry; reads `AUTHKIT_ISSUER`, `AUTHKIT_AUTHORIZE_URL` and `MCP_RESOURCE` from `wrangler.jsonc` vars.
  - `src/app.ts`: OAuth metadata and `/signin`, then `/mcp` behind Host validation and `requireBearerAuth`, then `createMcpHandler` serving 2026-07-28 and 2025-era clients statelessly from one factory. Modern inbox subscriptions stay open only while the authenticated member may read them.
  - `src/auth.ts`: verifies WorkOS AuthKit access tokens with jose (issuer, `aud` equal to the resource, RS256, `exp`). The key lookup is injectable; tests sign with a local key pair.
  - `src/backend.ts`, `src/journey.ts` and `src/objects.ts`: coordination, relay and Durable Object adapters. Task creation commits the task and next deadline alarm atomically; alarms expire overdue tasks after eviction. Agent capabilities are the intersection of the live person's authority and current card, and agents never receive grant authority.
  - `src/inbox.ts`: authenticated `wayfinding://journey/{id}/inbox` resources for assigned task polling and modern update subscriptions. Removal closes the subscription and prevents later reads.
  - `src/server.ts`: the per-request `McpServer` factory. `tasks/get`, `tasks/update` and `tasks/cancel` require the `io.modelcontextprotocol/tasks` extension metadata on every request and return `-32021` when it is absent. MCP Apps resources and tools are registered in the same server.
  - `test/*.test.ts`: drive the Worker's `fetch` in-process with the official `@modelcontextprotocol/client`. Name tests so `--test-name-pattern=auth`, `era`, `tasks`, `apps` and `relay` select the relevant cases.

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

- Code that must run in Node, browsers and Cloudflare Workers uses Web Crypto only. Node imports belong only in build scripts, tests, and the proxy CLI/file-store boundary.
- Use exact versions of official SDKs and libraries.
- Parallelize independent work where possible.
