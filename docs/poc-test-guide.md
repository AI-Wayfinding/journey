# Test the Wayfinding PoC

Wayfinding gives a team and its agents a shared journey: membership, tasks, artifact metadata and bounded agent permissions. A local MCP proxy encrypts and decrypts artifact content. The Cloudflare MCP server coordinates the work and relays ciphertext.

**Use synthetic data only.** The proxy uses unaudited ts-mls 1.6.4 and WorkOS AuthKit Staging. Do not upload client material, personal data or secrets. This is a proof of concept, not a production service.

## What is new in v2

The server now runs v2 state. Journeys created before the v2 deploy are not carried over; create a new one.

### Console

Open `https://poc.wayfinding.support/console` and sign in with the same Staging account. A signed-out visit redirects to sign-in. The console lists your journeys, agents and connected clients. It is the only place to:

- register a **passkey**;
- **widen** an agent's card (add capabilities), confirmed with a fresh passkey assertion;
- **bind** a connected client to an agent, so that client always acts as that agent.

Narrowing a card or removing an agent needs no passkey. Each journey page links to its library, forum and rounds.

### Agents and capabilities

`agent_create` makes an account-level agent with an **empty card**. An agent can do nothing until you widen its card in the console. Capabilities are named, for example `artifact.write`, `post`, `topic.create`, `round.contribute` and `member.invite`; `agent_capabilities` shows them for one journey. An agent never holds more than its owner. `agent.add`, `client.bind`, `card.change`, `passkey.manage` and `grant.issue` are never assignable. Add the agent to a journey with `agent_add`, then act as it by passing `actingAgent`, or bind a client in the console.

### Library

`library_add` stores an item with a kind (`markdown`, `html`, `pdf`, `code`, `image`, `video`, `audio`, `data`, `link`, `skill`, `prompt`, `agent`, `applet`, `other`), free labels, an optional project and `members` or `private` visibility. Use `library_search` to find items by text, kind, label or project, and `library_version` to add a version. `library_view` opens the library in an Apps-capable host.

### Forum

Each journey starts with a **General** board. Use `topic_create`, `topic_list`, `topic_read` and `post_create` for discussion. Every project and library item has one attached conversation: `conversation_post` and `conversation_read` with `target: { itemId }` or `target: { projectId }`. Posts record whether a person or an agent wrote them. `forum_view` opens the forum view.

### Sensemaking rounds

A round moves `planned` → `open` → `synthesising` → `closed`. `round_create` defaults to the **first-position** format and can point at a guidance item. Each participant's interview is private (`interview_write`, `interview_read`) until they call `interview_share`. Contributions (`round_contribute`) are attributed to the person and accepted while the round is open or synthesising. `round_next` starts the next round. `round_view` opens the round view.

### Verified live: 2026-10-30

Against `https://poc.wayfinding.support/mcp` (Worker version `35deaf71`), synthetic account A through the local proxy: created a journey and an agent; an `actingAgent` `topic_create` with an empty card was **refused** (`Forum topic.create capability refused`); added a markdown guide and a link to the library and found the guide with `library_search`; created a forum topic and commented on the guide's attached conversation; ran a first-position round through open, a private interview, share, a contribution and synthesising. A signed-out `GET /console` returned 303 to `/console/login`. Passkey widening and client binding need a browser and were covered by automated tests only.

## Verified live: 2026-10-29 (v1 state)

The full two-person walkthrough below **passed** against `https://poc.wayfinding.support/mcp` on 2026-10-29, from 19:59:41 to 20:00:16 UTC. Both local proxies used source commit `b7a6969`, fresh stores, separate browser sessions and the official MCP client SDK. All 31 tool calls passed their data assertions; the harness exited 0.

| Check | Observed result |
| --- | --- |
| Password sign-in, consent and loopback callback | Both users connected; `whoami` and `account_read` matched their Staging identities. |
| Journey membership | A created a request-only journey and admitted B as read-only. B could read it. |
| MLS setup | A created the group, B prepared a device package, A added it, and both synchronized. |
| Shared artifact | B decrypted the exact marker A created. |
| Personal artifact copy and move | B read both destination artifacts. Copy preserved the source; move removed it from the source's live list. |
| Assigned task | B claimed A's task and progressed through a round to `done`. |
| Agent limits | B's signed card requested read/write/grant; effective capabilities were read-only, with no grant or guide authority. |
| Cleanup | Both proxies stopped and both browser sessions closed. |

The earlier account provisioning blocker no longer occurs. This run found no application defect and required no deployment. It did not test a hosted Claude/ChatGPT connector or an Apps UI.

## Prepare

- Install Node **22.18 or later**, npm and an MCP client with local stdio support.
- Clone this repository, check out `rewrite-v2`, then run `npm ci` from its root.
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

### Check nicknames and email invitations

These checks cover newer source changes, not the live run recorded above. Use a server built from this revision.

After B has called `account_read` once, A can invite B with `journey_invite` using `journeyId` and B's synthetic WorkOS `email` instead of `personId`. Supply exactly one of the two; email matching ignores case. B then calls `journey_join`. Only guides may invite. An unknown email must return `No Wayfinding account uses that email yet; ask them to sign in once, then invite again`. Admission, refusal, role and guide changes still require `personId`.

Change B's nickname again and check that A's next `journey_read` shows it without rejoining. Other people's emails must not appear in journey results; a profile with only an email uses `Wayfinding member` until a nickname is set. Account existence lookup is a PoC privacy tradeoff restricted to guides, not a general email search.

## Walk through with A and B

Use the client's tool interface or ask its agent to make these calls. Save returned IDs; names are not IDs. For each call, check that `isError` is absent or false and inspect the returned data.

1. **Check identity.** Both call `whoami` and `account_read`. Confirm different subjects and record each `personId`; A also records `personalGroupId`. Call `account_update` with `nickname: "Synthetic A"` or `nickname: "Synthetic B"`, then check that `account_read` returns the trimmed nickname. Journey member and pending lists should show these names.
2. **Create and join.** A calls `journey_create` with `name: "Synthetic smoke"`, `policy: "request"`, `defaultRole: "read"`. Share its `journeyId` with B. B calls `journey_request`. A checks `journey_read`, then calls `journey_admit` with B's `personId`. B confirms access with `journey_read`. B remains read-only.
3. **Set up encryption.** Use the journey ID as `groupId`. A calls `mls_group_create` once. B calls `mls_group_prepare` and shares its returned `deviceId`. A calls `mls_group_add` with B's authenticated `personId` and that device ID. Both call `mls_group_sync`.
4. **Share content.** A calls local `artifact_create` with that `groupId`, `name: "Shared marker"`, `type: "text/plain"`, `content: "SYNTHETIC-WAYFINDING-MARKER"`. B calls `artifact_read` with its returned `artifactId`. Check the exact marker, not just a successful response.
5. **Copy and move personal content.** A calls `mls_group_create` with A's `personalGroupId`, then creates another marker artifact there. Call `artifact_copy` with `sourceGroupId`, `artifactId`, and `destinationGroupId` set to the journey ID. B reads the new destination ID. Confirm A can still read the source. A calls `artifact_move` on the original; B reads that new destination ID too. Confirm `artifact_list` in A's personal group no longer lists the original.
6. **Complete a task.** A calls `task_create` with `journeyId`, `name: "Synthetic task"`, `assignee` set to B's `personId`, `maxRounds: 3`, and `deadline` set to a future Unix timestamp in **milliseconds**. Find its returned `taskId`. B calls `task_step` with `journeyId`, `taskId` and actions `claim`, `startRound`, `endRound`, `finish`. Expect `claimed`, `inRound`, `claimed`, then `done`.
7. **Check agent limits.** B calls `agent_add` with `journeyId`, `name: "Synthetic agent"`, and `read`, `write`, `grant` all set to `true`. B calls `agent_capabilities` with the returned agent ID as `actingAgent`. Because B is read-only, expect `{ "read": true, "write": false, "grant": false, "guide": false }`. A requested card must not give an agent more authority than its owner.

## Limits and cleanup

- Membership admission and MLS device admission are separate steps. A member proxy must synchronize after admission; no background daemon does it for you.
- Artifact content is encrypted locally, but coordination metadata is visible to the server. The local store contains credentials and keys. Protect it.
- Copy and move create fresh destination identities and keys. Move copies first, then deletes the source; do not treat it as an atomic cross-group transaction.
- Stop the MCP clients/proxies and close both test browser sessions when finished. Keep synthetic accounts in Staging for retesting.
- After a crash, confirm the old proxy process has stopped before removing a stale store lock. Never restore an old MLS ratchet snapshot to recover from an ambiguous send.

To check the source checkout, run `npm run check:rules`, `npm run typecheck` and `npm test` from the repository root. These checks do not replace the live walkthrough.
