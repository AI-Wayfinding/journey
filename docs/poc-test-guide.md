# Test the Wayfinding PoC

Wayfinding gives a team and its agents a shared journey: membership, tasks, artifact metadata and bounded agent permissions. A local MCP proxy encrypts and decrypts artifact content. The Cloudflare MCP server coordinates the work and relays ciphertext.

**Use synthetic data only.** The proxy uses unaudited ts-mls 1.6.4 and WorkOS AuthKit Staging. Do not upload client material, personal data or secrets. This is a proof of concept, not a production service.

## Live check: 2026-10-29

The live test is **blocked**, not passed. On 2026-10-29 at 19:44 UTC, the saved synthetic user A completed password sign-in, consent and the loopback callback. The proxy then failed during account setup:

```text
Remote account_read refused: [{"type":"text","text":"Coordination storage operation failed"}]
```

The server emits this generic error at `packages/mcp/src/objects.ts:27`. It reaches the proxy at `packages/proxy/src/proxy.ts:183` during startup at `packages/proxy/src/cli.ts:39`. `wrangler secret list` confirmed the `WORKOS_API_KEY` secret name before this retry; its value was not inspected. The remaining failure in the account provisioning path (`packages/mcp/src/accounts.ts:28-40`) needs Worker-side diagnosis. The generic response does not establish the cause. B's sign-in and all collaboration calls below were not reached. Both test browser sessions were closed and no proxy remained alive.

The source now rejects a missing, empty or blank `WORKOS_API_KEY` before contacting WorkOS, with `Server configuration error: WORKOS_API_KEY is required for account profiles`. This diagnostic change needs deployment; nothing was deployed in this run. It is not evidence that the live blocker is fixed.

## Prepare

- Install Node **22.18 or later**, npm and an MCP client with local stdio support.
- Clone this repository, check out `rewrite-poc`, then run `npm ci` from its root.
- Arrange two synthetic accounts in **WorkOS Staging**, with verified email and password sign-in. Use an unclaimed domain such as `test.wayfinding.support`. Avoid `example.com`: the Staging Test Organization claims it and changes the sign-in route.
- Keep passwords out of chat, shell history and Git. An operator creating accounts needs the Staging API key; MCP users do not.

The current endpoint is `https://poc.wayfinding.support/mcp`. Its sign-in issuer is `https://welcoming-folk-53-staging.authkit.app`.

### Server setup (deployment operator only)

The Worker needs a **`WORKOS_API_KEY` secret** for account profile provisioning. It must be a Staging User Management key matching the Staging issuer, not a client token. Set it through Wrangler's hidden prompt from `packages/mcp` with `npx wrangler secret put WORKOS_API_KEY`. Never put its value in `wrangler.jsonc`, Git or a command argument. `npx wrangler secret list` shows names only. Changing a secret can publish a Worker version, so do not run the setup command during a no-deploy smoke test. An MCP client user needs no API key.

## Connect the local proxy

Add this server to a client's local MCP configuration, for example Claude Code's `.mcp.json`. Replace both absolute paths; JSON arguments do not expand `~`.

```json
{
  "mcpServers": {
    "wayfinding": {
      "command": "node",
      "args": [
        "/absolute/path/to/journey/packages/proxy/src/cli.ts",
        "--store", "/absolute/path/to/your/home/.wayfinding"
      ]
    }
  }
}
```

The default store is `~/.wayfinding` when `--store` is omitted. Use a new store per device and per test account. An existing directory must belong to you and have mode `0700`; its records use `0600`. Do not share a store between running proxies.

The client launches the proxy. Open the **Sign in to Wayfinding** URL from its stderr log. Enter the synthetic email, continue to the password page, wait for it to load, then click exactly **Sign in**, not **Sign in with a passkey**. On consent, wait until **Allow access** is enabled and approve the loopback redirect you just started. Return to the MCP client after the callback says you are signed in. The first connection may take longer than the client's usual startup timeout.

For a two-person test, use separate client processes and browser profiles. Add `"--port", "8721"` to A's arguments and `"--port", "8722"` to B's. Give each a separate absolute store path. The default loopback port is `8717`.

## Connect a remote client with Apps support

In Claude or ChatGPT, add a custom MCP connector using `https://poc.wayfinding.support/mcp` and complete the Staging sign-in and consent. Availability and labels depend on the client's plan and version. An Apps-capable host can show the journey's embedded views.

The remote connection offers coordination, metadata and encrypted relay tools. It does **not** decrypt content. Remote `artifact_create` is a metadata tool, unlike the local proxy's content tool with the same name. Use the local proxy for plaintext artifact creation, reading, copying and moving. This guide does not establish that any particular hosted client's connector or Apps UI works.

## Walk through with A and B

Use the client's tool interface or ask its agent to make these calls. Save returned IDs; names are not IDs. For each call, check that `isError` is absent or false and inspect the returned data.

1. **Check identity.** Both call `whoami` and `account_read`. Confirm different subjects and record each `personId`; A also records `personalGroupId`.
2. **Create and join.** A calls `journey_create` with `name: "Synthetic smoke"`, `policy: "request"`, `defaultRole: "read"`. Share its `journeyId` with B. B calls `journey_request`. A checks `journey_read`, then calls `journey_admit` with B's `personId`. B confirms access with `journey_read`. B remains read-only.
3. **Set up encryption.** Use the journey ID as `groupId`. A calls `mls_group_create` once. B calls `mls_group_prepare` and shares its returned `deviceId`. A calls `mls_group_add` with B's authenticated `personId` and that device ID. Both call `mls_group_sync`.
4. **Share content.** A calls local `artifact_create` with that `groupId`, `name: "Shared marker"`, `type: "text/plain"`, `content: "SYNTHETIC-WAYFINDING-MARKER"`. B calls `artifact_read` with its returned `artifactId`. Check the exact marker, not just a successful response.
5. **Copy and move personal content.** A calls `mls_group_create` with A's `personalGroupId`, then creates another marker artifact there. Call `artifact_copy` with `sourceGroupId`, `artifactId`, and `destinationGroupId` set to the journey ID. B reads the new destination ID. Confirm A can still read the source. A calls `artifact_move` on the original; B reads that new destination ID too. Confirm `artifact_list` in A's personal group no longer lists the original.
6. **Complete a task.** A calls `task_create` with `journeyId`, `name: "Synthetic task"`, `assignee` set to B's `personId`, `maxRounds: 3`, and `deadline` set to a future Unix timestamp in **milliseconds**. Find its returned `taskId`. B calls `task_step` with that ID and actions `claim`, `startRound`, `endRound`, `finish`. Expect `claimed`, `inRound`, `claimed`, then `done`.
7. **Check agent limits.** B calls `agent_add` with `journeyId`, `name: "Synthetic agent"`, and `read`, `write`, `grant` all set to `true`. B calls `agent_capabilities` with the returned agent ID as `actingAgent`. Because B is read-only, expect `{ "read": true, "write": false, "grant": false, "guide": false }`. A requested card must not give an agent more authority than its owner.

## Limits and cleanup

- Membership admission and MLS device admission are separate steps. A member proxy must synchronize after admission; no background daemon does it for you.
- Artifact content is encrypted locally, but coordination metadata is visible to the server. The local store contains credentials and keys. Protect it.
- Copy and move create fresh destination identities and keys. Move copies first, then deletes the source; do not treat it as an atomic cross-group transaction.
- Stop the MCP clients/proxies and close both test browser sessions when finished. Keep synthetic accounts in Staging for retesting.
- After a crash, confirm the old proxy process has stopped before removing a stale store lock. Never restore an old MLS ratchet snapshot to recover from an ambiguous send.

To check the source checkout, run `npm run check:rules`, `npm run typecheck` and `npm test` from the repository root. These checks do not replace the live walkthrough.
