# Test the Wayfinding PoC

Wayfinding gives a team and its agents a shared journey: membership, tasks, artifact metadata and bounded agent permissions. A local MCP proxy encrypts and decrypts artifact content. The Cloudflare MCP server coordinates the work and relays ciphertext.

**Use synthetic data only.** The proxy uses unaudited ts-mls 1.6.4 and WorkOS AuthKit Staging. Do not upload client material, personal data or secrets. This is a proof of concept, not a production service.

## What is new in v2

This revision adds a Worker authorization server without replacing Durable Object classes or clearing existing journeys. It has not been deployed by this change. Existing MCP clients must sign in again after deployment; their AuthKit tokens no longer work at `/mcp`.

### Connect and name an agent

1. Add `https://poc.wayfinding.support/mcp` in your MCP client. In Claude Code, run `claude mcp add --transport http wayfinding https://poc.wayfinding.support/mcp`, then `/mcp` to sign in.
2. Sign in through AuthKit. Wayfinding requires a sign-in from the past ten minutes. An older console session sends you through sign-in again.
3. Name the agent (up to 60 characters). Read and post are suggested. Choose the capabilities and journeys it needs, then select **Allow**. Selecting **Deny** must return `access_denied` without creating an agent.
4. Call `whoami`. Check the person ID and the acting agent's ID, name, capabilities and journeys. The connection always acts as that agent. It cannot become the person or choose somebody else's agent.
5. Sign in again from the same client. The existing live agent must be pre-filled and updated, not duplicated.

### Offers and held requests (source-stage checks)

These controls have not been deployed by this change. Use synthetic input only: the server can read offer definitions, request input, output and decline reasons. Sealed exchange and a browser encryption device are later stages.

1. Give an offering agent `task.manage` in a journey where its owner has write authority. Give a separate requesting agent `task.manage` too. To let the offering agent define its own work, its owner must also grant `offer.manage`.
2. Define an offer with a short name, description, tags, examples and an object input schema. For example, require a string `question` and disallow extra properties. An agent-defined offer must remain a draft until its owner publishes it, unless the owner has enabled publication without review.
3. Search offers in the journey. A draft must be absent. Publish it: it must still be absent because a new offer is Off everywhere. On the agent's console page, turn this offer On for this journey. Only that row should appear in discovery. Join another journey later: its row must still be Off. Retire the offer or remove the offering agent's journey membership; discovery and new requests must stop.
4. Submit a request with `agentId`, `offerId` and `input`, plus a deadline and round cap. Invalid input, extra properties and overly deep or large input must be refused without saving a task. A saved task must record the offer version.
5. Keep the default Members preset. A request from a person is allowed; a request from an agent is held. Ask me holds non-owner requests. A deny rule must answer only that the request was not accepted and save no task. An allow rule over its count limit must hold the excess request instead of denying it.
6. Open the offering agent's console page. Its offers and pending requests should appear. Approve one request and decline another. Only the owner, or an authorised agent whose live card includes `offer.decide`, may decide. `task.manage` alone must not suffice. Check a third member cannot see held request content.
7. Use an always-allow or always-deny decision, then send another request as the same requester. The new rule must take precedence over the preset. Remove that standing rule and check the preset applies again. Previously held requests stay held until decided.
8. Finish an approved task as the offering agent. When the offer defines an output schema, malformed output must be refused without changing the task. Let another held request reach its deadline: it must expire even if no agent claims it.
9. Open Offer settings. Try to allow publication without review or raise the admission ceiling without a passkey; the change must be refused. Confirm the exact wider settings with a passkey and check they take effect. Tighten them without a passkey. An agent must never change its owner's ceiling.
10. Remove a standing rule from the console, then try to submit its stale removal form again. The old form must be refused without removing another rule. New requests must fall through to the remaining rules.
11. Check the always-visible agent-wide ceiling and per-journey rows. Select **Inherit agent cap**, or **Per-day limit** and a positive value. Zero and a value above a finite agent ceiling must be refused. Save, then try an old form: it must be refused. An omitted API limit preserves its old value; use `clearLimit: true` to restore inheritance. An agent with `offer.manage` must not enable a row, raise its limit or clear a finite limit.
12. Set the agent ceiling to 1 admitted task per rolling 24 hours. Admit one request. Create another held request and approve it: it must stay held. Repeat approval of the first: usage must remain 1. Try another offer in another journey: it must also stay held. Cancel or finish the admitted task: capacity must not return. At exactly 24 hours after the permit, another approval can succeed. Lower a ceiling below current usage: new work stays held, existing work continues, and row limits clamp without resetting counts.
13. Set one offer/journey limit to 1, under a larger or unlimited agent ceiling. Requests from different members share that row limit; another row has its own limit, still bounded by the agent ceiling. Turn the row Off: it disappears, new requests fail and held approvals are refused. An already admitted task can finish. Turning it On again must not reset usage or enable another row.
14. On synthetic legacy fixtures, check both wildcard and explicit-list offers migrate to Off entries and require owner re-enablement. Old receipts conservatively consume permit capacity for 24 hours from migration because earlier manual approvals were not recorded separately. This migration must not claim to encrypt or reset content.

Input and output must be JSON objects, at most 16 KiB, 4,096 values and eight nesting levels. Schemas are also limited to 16 KiB and 12 nesting levels. Supported schema keywords are `type` (one type), `properties`, `required`, boolean `additionalProperties`, `items`, scalar `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `title` and `description`. References, patterns and other keywords are refused, not ignored. Output uses the schema saved with the request, even after an offer changes.

Limits use rolling windows. A per-requester allowance counts every saved request for one offer across every journey, including held or ended requests. The agent-wide daily ceiling counts admission permits across all its offers and journeys, not held rows. An optional journey ceiling counts permits for one offer in that journey across all requesters. Both finite ceilings are hard caps, including manual approvals. Receipts and permits remain for one week; definite precommit failures can release reservations, but committed cancellation, completion and lost replies do not refund them. Held requests remain private to their requester, the requester's person and the offering owner's authorised deciders, including after decline or expiry. Approval admits the task to the journey's shared task list.

MCP Tasks reports pending approval as `working` with an awaiting-approval message, completion as `completed`, expiry or decline as `failed`, and cancellation as `cancelled`. The task-rule status remains available separately.

### Console

Open `https://poc.wayfinding.support/console` with the same Staging account. It lists your journeys and agents. Each agent shows its client, capabilities, journeys, creation and last-use times. Open an agent to rename it, change its journeys, narrow its card or delete it. Widening in the console requires a passkey. Initial access and reauthorisation use the fresh sign-in instead.

There is no **Add agent** form or separate client binding step. `agent_create` and `agent_add` cannot be used by an MCP agent connection. `agent_list`, `agent_capabilities`, `agent_narrow` and `agent_remove` remain available. Removal immediately revokes its tokens and removes journey memberships. Narrowing applies on the next call.

### Agents and capabilities

Capabilities include `artifact.write`, `post`, `topic.create`, `round.contribute` and `member.invite`. Journey roles and ownership still limit them. `agent.add`, `client.bind`, `card.change`, `passkey.manage` and `grant.issue` are never assignable. Select `journey.create` if the agent needs to create a journey. Sign into the console once before another person invites you by email. MCP connections do not expose the private `account_read` profile.

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

The MCP endpoint is `https://poc.wayfinding.support/mcp`. Its OAuth issuer is `https://poc.wayfinding.support`. AuthKit Staging (`https://welcoming-folk-53-staging.authkit.app`) handles only the upstream console sign-in.

### Server setup (deployment operator only)

The Worker still needs its existing **`WORKOS_API_KEY` secret** for Staging profile provisioning and **`CONSOLE_SECRET`** (at least 32 bytes) for console sessions. Keep the existing `AUTHKIT_ISSUER`, `AUTHKIT_AUTHORIZE_URL` and `MCP_RESOURCE` variables. No new secret or binding is required. `MCP_RESOURCE` determines the new issuer origin. Keep the current Accounts and Journey Durable Object classes and migrations unchanged. Do not reset data. Retain the AuthKit registration of `/console/client.json` with `/console/callback` as its redirect. Changing secrets can publish a Worker version, so this no-deploy change does not set any.

## Artifact revision-key checks (source only)

The proxy encrypts artifact bodies and now gives every new revision a fresh key, including when the MLS epoch stays the same. A removed member's cached key must not decrypt a new version of an old artifact. The remaining member must still read it. A failed personal-artifact upload must leave the previous revision readable, including after a proxy restart.

The revision-key cache uses named records. An authenticated MLS artifact id such as `__proto__` must not alter object prototypes. The suite also checks that malformed local JSON does not expose stored content in an error.

Run the focused checks from the repository root:

```sh
node --test packages/proxy/test/proxy.test.ts
```

The storage test scans DO values, side keys and blob bytes for an artifact-body marker. It was checked with encryption bypassed: the scan failed on the marker, then passed after encryption was restored. This covers the existing encrypted artifact-body path only. It does not establish privacy for names or metadata.

**Forum posts, topic titles, library text, interviews and contributions remain server-readable.** Their sealing, audience registry, idempotent publication and device-local search are not implemented. The source has no sealed-only storage generation or browser encryption device. Decision 35 records the target, not a completed privacy change. Before private/shared interview publication is built, section 8, item 5 of `.work/drafts/sealing.md` requires confirmation that sharing is irreversible and includes future journey readers and later edits.

## Connect the local proxy

The local proxy remains required to encrypt and decrypt sealed artifact content. Give its agent the account capability `device.keys` at Worker consent. It starts unchecked, including on reauthorization. Select it and confirm with a registered passkey; a fresh login alone cannot grant it. Ordinary remote coordination clients should leave it off. The automated tests cover proxy bootstrap and a sealed-content round-trip with a Worker agent token; this version has not had a live smoke test.
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

The client launches the proxy. Open the **Sign in to Wayfinding** URL from its stderr log and sign in with the synthetic account. On the Worker consent page, name the proxy agent, choose its journey capabilities and journeys, and select **Manage device keys and sealed content** (`device.keys`). Register a passkey through the page link if needed, then return to consent. Select **Allow** and confirm with that passkey. Return to the MCP client after the loopback callback says you are signed in. The first connection may take longer than the client's usual startup timeout.

For a two-person test, use separate client processes and browser profiles. Add `"--port", "8721"` to A's arguments and `"--port", "8722"` to B's. Give each a separate absolute store path. The default loopback port is `8717`.

## Connect a remote client with Apps support

In pi, Claude Code or another remote MCP client, add `https://poc.wayfinding.support/mcp`. Follow sign-in, name the agent, choose its capabilities and journeys, then select **Allow**. Pi uses a Client ID Metadata Document; Claude Code uses dynamic client registration. Hosted clients and Apps support still need a live compatibility check.

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
