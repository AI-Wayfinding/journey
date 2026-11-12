# Test the Wayfinding PoC

Wayfinding gives a team and its agents a shared journey with membership, tasks and bounded permissions. In the current sealed-v1 source, the local MCP proxy encrypts descriptive content, including offers, task exchanges and profile/card text. The Cloudflare MCP server coordinates work and relays ciphertext. Routing and authority metadata remain readable.

**Use synthetic data only.** The proxy uses unaudited ts-mls 1.6.4 and WorkOS AuthKit Staging. Do not upload client material, personal data or secrets. This is a proof of concept, not a production service.


## Sealed content checks (source only)

This stage is not live verification of the public endpoint. Run its tests locally against the in-process Worker and real MLS proxy. The historical walkthroughs below describe older deployments.

### Privacy boundary

- Sealed: journey/project names and purposes; board names/descriptions; topic titles and post bodies; attached conversations; library names, labels, metadata, bodies and versions; round descriptors, guidance, synthesis, interviews and contributions; artifact names and metadata.
- Also sealed: offer names, descriptions, tags, examples, schemas, resources and instructions; task names, input/output, input requests/answers, decline/failure reasons and conversations; profile name/nickname/email and device/passkey labels; agent/card name and client name.
- Still readable: authenticated person/agent/device ids, memberships, capabilities, admission rules, ceilings, offer/task ids, pinned offer references/versions, parent links, visibility, statuses, counters, deadlines and byte counts. Accounts retains a keyed email routing index, not raw email. Traffic patterns and ciphertext sizes are visible too.
- J carries journey material and explicit offer/alias publications; P carries owner-only private items, offer sources and identity descriptors; T carries one task; I carries one participant's private interview. Sharing publishes a separate J copy irreversibly, including to future journey readers. Later interview edits update I and J atomically; the private workspace remains in I.
- Revocation cannot erase text or keys a former reader already saved. New content requires removal of departed leaves and fresh encryption. Each large revision has a new AES-256-GCM key, even without a group epoch change.
- Device bindings record the authenticated person/agent, verification key and key package. The client verifies MLS rosters, signatures and content contexts before rendering. An agent without both live `read` and `device.keys` receives an explicit refusal, never an automatic grant.
- Search terms, labels and kind filters are evaluated locally. A missing audience or retained packet produces `partialIndex`/`contentUnavailable`, not a claim of complete results. Adding a device requires an existing member to re-share entitled live retained history; incomplete local history refuses the transfer.
- The browser and proxy enforce account-signed connection packages and keep local account-key pins. The unlocked console opens private content; locked views show **sealed — open in your client**. Personal workspace aliases are device-local. Hosted JavaScript, first-contact comparison and unaudited ts-mls remain launch gates; real-data mode is refused.

### Bounds and recovery

A group retains at most 4,096 application messages and 32 MiB of content ciphertext, without silent eviction. Updates have a separate 4,096-message/32 MiB budget; admission, removal and history share a separate 4,096-message/256 MiB budget. Per person and group, across all their devices and agents, the limits are 128 updates/4 MiB, 2,048 application messages/16 MiB and 1,024 admission/history messages/64 MiB. Envelopes are at most 1 MiB, device packages 64 KiB, local payloads 9 MiB and encrypted uploads 10 MiB. Listings are paged at 100 records and 4 MiB. A journey allows 1,024 content records, 128 groups and 128 active preparation tickets; each group allows 128 devices. Retained uploads have a separate 32 MiB journey limit and 16 MiB per-person limit. Abandoning or expiring an uncommitted ticket refunds both upload reservations and deletes its unreferenced bytes on the next request. Exhausted budgets refuse writes.

Preparation tickets and pending uploads expire after ten minutes. Device checkpoints expire after thirty days without a successful fetch. Large-body uploads become readable only through a committed, entitled record/version reference. Item metadata edits also advance the content revision.

Shared artifact writers may add content versions and edit metadata, but only the owner changes visibility. Check that metadata edits advance the ciphertext revision without consuming a content version. Topic authors may lock their topics; guides may moderate them; only post authors edit their posts. `packages/proxy/test/metadata.test.ts` runs these checks against both backends.

A move must refuse predictable source-delete denial before creating a destination copy. After a copy succeeds, an unconfirmed delete returns a partial receipt with both artifact ids. Check `sourceState: unknown` even when the server accepted deletion but its reply was lost. Inspect both records before retrying; do not treat this as a completed move or retry it blindly.

Before final publication, the proxy saves its advanced ratchets and exact pending ciphertext. After a lost reply, it checks the server receipt and either completes locally or retries that same ciphertext. A proved uncommitted, expired ticket can be abandoned without rolling a ratchet back. Unresolved handshake/history delivery fails closed; do not restore an old MLS snapshot.

The current proxy requires the server to report `sealed-v1` before startup and each remote operation. It saves a local mode pin and refuses a missing mode, a downgrade or a legacy store without an explicit migration. The old relay tests use a test-only harness; there is no plaintext fallback in the shipped proxy.

### Offers, task exchange and private names

Run these checks with synthetic fixtures and enrolled local devices, not the browser console. First use of P creates a personal-workspace journey and requires `journey.create` as well as the action's normal authority and explicit read/device keys. Workspace aliases are device-local; the proxy does not silently add capabilities or recover another device's alias:

1. Define an offer through local `offer_set`. Omit `offer.id` to generate an opaque id; retain the returned id for updates. Supply explicit enabled journey rows. Check `offer_list` opens the private P source for the owner, while `offer_search` opens only the selected J copy. A missing, stale or wrong-group copy must not be discoverable. Search queries and tags must not be sent upstream.
2. Call `task_prepare` for an offered task. It returns T and `taskId` without creating a task or consuming capacity. The requester creates T. The offering agent and its owner prepare devices, then the requester adds them. Retry local `task_create` with that `taskId` and the original input. A named non-offer assignee follows the same admission step. For an unassigned task, `task_claim_prepare` nominates the claimant, who must join T before claiming.
3. Supply invalid input through the requester and hostile, correctly encrypted invalid input through the test fixture. The requester must refuse before sealing; the receiver must refuse after opening. A substituted schema snapshot must be refused too. The publication pinned at preparation, not the latest offer or caller-supplied schema, is authoritative. Invalid output must fail at the producer and reader. JSON output without a schema still has the 16 KiB/depth/node limits.
4. Exercise claim, rounds, `askInput`, requester `answer`, finish, cancel, decline, failure and deadline expiry. A claimant cannot answer for the requester. An unrelated journey member cannot read T or its conversation. Ask/answer/fail use sealed `task_step`; raw MCP `tasks/update` input responses are refused. Tasks extension declarations remain required; get/cancel and working/input-required/completed/failed/cancelled status mapping remain available.
5. Set private profile fields through local `account_update`. Its optional `publications` map selects journey-specific `{nickname}` copies. Use `agent_descriptor_set` with `{agentId,name,clientName?,publications?}` for private card text and explicit J aliases. `account_read` and `agent_list` open P locally. Omitted publications withdraw current aliases without erasing historical ciphertext. Email and device/passkey labels must never appear in a profile J projection.
6. Provision an account before enrolling a device: storage must contain neither the fetched AuthKit name nor email. Invitations match trimmed, lower-case authenticated email through HMAC. Editing private profile email must not change routing. Raw nickname/card/passkey rename routes must refuse; OAuth/console controls use ids or the fixed `MCP client` label. Missing `read` or `device.keys` must produce an actionable refusal, never an added grant.

The console can still change authority and admission metadata while locked. Private content uses the browser device below or the local proxy; neither changes the server's ids/status-only view.
Released MCP App resources remain available unchanged. Their older tool wrappers are not advertised in sealed-v1; use the browser device or local proxy for content.

### Account signatures and safety numbers (F4)

Use fresh synthetic accounts; older unsigned connections must be enrolled again.

1. Complete first-browser onboarding. Unlock Profile and check **Your safety number**. Reload and unlock with PRF: the number must stay the same. Server records must contain the public key and encrypted recovery envelope, never the private account key.
2. Add a browser with the saved account recovery code. Its number must match the first browser's. A wrong code, another account's envelope or a substituted public key must fail. Separately, unlock an approved browser that has no local account key using its connection unlock code. It must open without trying that code against the account envelope. The separate **Recover account signing key** action must restore signing only with the account recovery code. Losing local MLS state does not reconstruct history; keep a surviving eligible connection online.
3. Add a browser without the account recovery code, or start a fresh local proxy. It must stop at a pending connection request, showing its local request code and a retry control. Reload while pending and unlock: the same connection id and request code must remain. In a trusted browser, refresh requests and enter the code from the requesting device. The approver must not display the expected code beside its input. A wrong code must refuse signing. Sign the matching request and select **Check for approval** on the new browser; it must enroll the original connection without recreating the vault. A mere email sign-in or fresh passkey cannot replace this approval.
4. In a journey, first-seen member safety numbers must say they have not been compared. Compare them outside Wayfinding and explicitly accept them. Replace a member's server-provided MLS package or packet key in an in-process fixture: browser/proxy admission and history sharing must refuse it. Unsigned old records must return an explicit connection refusal. A packet rejected during inbound validation must leave the saved ratchet, cursor and blocked flag unchanged, allowing a valid retry and reopen.
5. Check both the account and journey identity logs for signed connection additions and removals. Alter a signed entry or supply a self-signed entry from an unpinned key: the account log must fail closed, with no **Signature verified** label and no unsigned downgrade. Previously pinned generations must still verify. An unsigned removal must say **Server report — unsigned**, never verified. These checks do not prove completeness or detect replay and reordering.
6. Remove a signed connection from the unlocked browser. Its later enrollment, reads and new audience packages must fail. Recovery without the account code must revoke all old connections and agents immediately. Advance the synthetic clock past the 72-hour deadline and sign in again; first-browser setup must create a different number. An existing journey member must see the changed number before synchronization and encryption resume. Compare and accept it; pre-recovery packets and old-generation bindings must still verify. A new joiner must pin the new key, authenticate its predecessors through signed key-change entries and verify retained history. Agents need fresh authorization and connection signatures.
7. Run `node --test packages/mcp/test/recovery-capacity.test.ts packages/proxy/test/account-encoding.test.ts`. A reset at 128 historical roots must allow a fresh signed connection. A full journal must refuse before changing passkeys, agents or recovery state. Noncanonical base64 aliases of the old key must not count as a replacement key.

### Browser connections, onboarding and recovery

Use synthetic data only. These are source checks, not a deployment claim. The hosting Worker can replace both the page and its CSP. MLS and the browser vault have not had an independent security audit. Web Locks, IndexedDB, Web Crypto and a secure browser context are required. Missing storage or locks must refuse, never fall back to plaintext.

1. Sign in to `/console` with a new account. Every ordinary console page must redirect to setup. Set **Your name**, then **Create passkey and trust this browser**. Empty names and cancelled passkey prompts must leave setup incomplete. Confirm the passkey prompts for registration, PRF unlock and exact browser enrollment.
2. Save the displayed recovery code outside the browser. A wrong retyped code must refuse continuation. Retype the correct code and select **I saved my recovery code — continue**. The console becomes available only after a private name update, a live browser connection and code confirmation. The raw code and PRF output must never appear in requests or server storage. With no PRF support, the code unlocks this browser's encrypted vault.
3. In **Your connections**, check Browser and Agent rows, added/last-used times and remove actions. This browser shows Locked or Unlocked. Unlock to read private names. There must be no separate Agents or Private browser device box, manual audience/admission inputs or raw JSON output. Profile and account lets the person edit their private name after unlock.
4. Select **Lock this connection**. Decrypted output and key access disappear. A wrong local recovery code must refuse; the correct code and a PRF-capable passkey must unlock. Reload and unlock again. Another tab must refuse concurrent unlock. Lock/logout/pagehide retains the writer fence through pending IndexedDB commits, then releases it. IndexedDB must contain neither plaintext profile content nor the recovery code.
5. Remove an owned browser row. Its later private reads must refuse, including with old local state. Removing an unknown browser must refuse. Keep another admitted connection alive to test sharing after removal. A wrapping passkey with live browser leaves cannot be deleted; the last passkey cannot be deleted even without browser leaves. Removing a connection cannot recall content already read.
6. In a new browser, open `/console/recover`. Email sign-in alone must not add a passkey. Confirm an existing passkey, or enter the saved account recovery code, then add the new passkey and browser. Wrong codes and replayed/expired assertions must refuse. The account person id, private profile descriptor and recovery generation stay unchanged. A surviving eligible connection must admit the new browser before existing encrypted history can be read. When using an existing passkey without the account code, save the separately labelled local connection unlock code; it must not replace the account recovery code.
7. From **Profile and account**, expand the lost-code option. The wrong removal confirmation must refuse. Type **REMOVE ALL CONNECTIONS** and start recovery. Every browser, agent, binding, card and passkey is removed immediately; access and refresh tokens stop working. Repeated start requests preserve the original deadline. Agents cannot start or cancel recovery. There is no cancellation operation.
8. With the test clock, check one millisecond before 72 hours: first/additional passkey registration, saved-code recovery and browser enrollment must all refuse. At exactly 72 hours an old console login still cannot continue; sign in again. The console supplies the next step because no mail sender exists. Create a new first passkey/browser, name and code. The person id stays stable, the account is marked recovered, the recovery generation advances and old agents remain dead. Add agents again explicitly.

**Code recovery does not restore lost storage.** The code authorizes an additional passkey and can unlock an existing local vault. It cannot recreate a deleted vault or roll back an MLS state. No-code recovery clears the lost private-workspace descriptor and creates a fresh workspace; lost content keys remain lost. `recoveryAccountWrappingKey` unwraps the same account signing key with the saved code. Without that code, the new first browser creates a replacement key and safety number; journey logs record the change (F4 above).

### Scripted browser proof

Start an isolated Chrome profile with a debugging port, or use `agent-browser --session sealing-proof open about:blank` followed by `agent-browser --session sealing-proof get cdp-url`. Read that port's `/json/list` and use its page-target WebSocket URL:

```sh
node packages/browser/test/console-e2e.mjs ws://127.0.0.1:PORT/devtools/page/TARGET
```

The harness intercepts application requests and serves the in-process console with a synthetic login. It contacts no remote Worker. It uses a CTAP2.1 virtual authenticator and checks required-name setup, wrong/right saved-code confirmation, the unified connections box, PRF wrapping, encrypted IndexedDB, inert profile markup, lock/write fencing and wrong/right local recovery. Add `--no-prf` to exercise the code-only fallback. The harness clears IndexedDB and local storage for the application origin; use only an isolated test profile. Close that browser afterwards.

Chrome with CDP WebAuthn PRF support is required. This rewritten onboarding harness has not completed a native-browser run in this change: the local browser launcher failed before the CDP connection could be used. The in-process integration tests exercise both account recovery paths. No native-browser success is claimed for this revision.

For an optional local Worker run, start `npx wrangler dev` from `packages/mcp`, prepare a synthetic signed-in login at that browser origin, then pass `--wrangler http://127.0.0.1:8787`. Only loopback targets are accepted. Configure local AuthKit/console secrets and callback routing separately. This path does not mint a Worker login or deploy anything and has not been exercised here.

### Automated checks

From the repository root:

```sh
node --test packages/proxy/test/sealed.test.ts packages/proxy/test/sealed-tasks.test.ts packages/proxy/test/sealed-identities.test.ts packages/mcp/test/sealed-contract.test.ts
node --test packages/browser/test/vault.test.ts packages/mcp/test/sealing-browser.test.ts packages/mcp/test/console-browser.test.ts packages/mcp/test/onboarding.test.ts packages/mcp/test/onboarding-console.test.ts
npm run typecheck
npm test
npm run check:rules
(cd packages/mcp && npx wrangler deploy --dry-run)
```

The storage canary writes distinct markers through the proxy for every sealed field type, then scans all Durable Object values, including side keys, and all blob bytes. It also checks private interview isolation, future-reader history, irreversible sharing and later shared updates, large revision keys and tampering, assigned source isolation, attributed concurrent contributions, closed-round successors, personal copy/move and exact-once lost-reply recovery. A device-revocation race occurs between Journey validation and Accounts permit issuance.

Offer, task and identity canaries additionally scan every new descriptive field, including schema annotations, input/output, requests/answers, decline/failure reasons, conversations, email and device/passkey labels. Scans cover all DO values/side keys and raw blob bytes; early scans detect a leak before an MLS decoder can fail for another reason. Plaintext remote offer/task/identity writes are refused.

The following temporary mutations were each observed to turn a passing test red, then restored:

| Bypassed control | Observed failure |
| --- | --- |
| Replace MLS sealing with the clear signed packet | Storage scan finds `CANARY-journey-name-40fa64` |
| Remove envelope audience equality | Wrong-audience assertion no longer throws |
| Remove decoded byte-size equality | Size assertion no longer throws |
| Replace the fixed content-type literal with an arbitrary string | Unknown-format assertion no longer throws |
| Omit live audience-device checks during permit issuance | Revocation-race publication no longer rejects |
| Bypass sealing for offer/task/profile/card packets | Three canaries fail on `OFFER-NAME-CANARY`, `TASK-NAME-CANARY` and `PRIVATE-PROFILE-NAME` |
| Remove receiver validation of opened task input | Hostile invalid-input assertion no longer rejects |
| Remove envelope audience equality for the new exchange | Wrong-group envelope assertion no longer throws |
| Derive the recovery key from a constant instead of the supplied code | Recovery test exits 1: `Missing expected rejection` for the wrong code |
| Add `unsafe-eval` to the console's `script-src` | CSP test exits 1: forbidden-policy assertion fails |

Malformed/plaintext sealed inputs, incomplete multi-envelope manifests, oversized input, noncanonical base64 and unauthorized blob references must leave published content unchanged. Restore every mutation before running the full gates. A dry run bundles only; it does not authorize a deployment.

## Historical v2 walkthrough (not sealed-v1)

The Worker authorization server replaces AuthKit MCP tokens with its own tokens; existing MCP clients must sign in again after deployment. The `prototype-reset-v1` migration deletes every earlier storage class and its data. Journeys start empty in `JourneyResetV1`, and accounts in `AccountsPartitionedV1`. Everyone signs up again.

### Connect and name an agent

1. Add `https://poc.wayfinding.support/mcp` in your MCP client. In Claude Code, run `claude mcp add --transport http wayfinding https://poc.wayfinding.support/mcp`, then `/mcp` to sign in.
2. Sign in through AuthKit. Wayfinding requires a sign-in from the past ten minutes. An older console session sends you through sign-in again.
3. Name the agent (up to 60 characters). Read and post are suggested. Choose the capabilities and journeys it needs, then select **Allow**. Selecting **Deny** must return `access_denied` without creating an agent.
4. Call `whoami`. Check the person ID and the acting agent's ID, name, capabilities and journeys. The connection always acts as that agent. It cannot become the person or choose somebody else's agent.
5. Sign in again from the same client. The existing live agent must be pre-filled and updated, not duplicated.

### Legacy offers and held requests

These steps describe the earlier unsealed implementation. They are not the current sealed-v1 privacy or UI contract; use the source checks above. Use the browser-device steps above for the current sealed implementation.

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

The Worker needs the existing **`WORKOS_API_KEY` secret** for Staging profiles and **`CONSOLE_SECRET`** (at least 32 bytes) for console sessions. Keep `AUTHKIT_ISSUER`, `AUTHKIT_AUTHORIZE_URL` and `MCP_RESOURCE`; the resource determines the issuer origin. The sealed-v1 configuration switches bindings to the new sealed classes and appends a migration while retaining old classes and data. Do not reset data or deploy this stage. Retain the AuthKit registration of `/console/client.json` with `/console/callback` as its redirect. Secret changes can publish a Worker version, so this work changes no secret.

## Artifact revision-key checks (source only)

The proxy encrypts artifact bodies and now gives every new revision a fresh key, including when the MLS epoch stays the same. A removed member's cached key must not decrypt a new version of an old artifact. The remaining member must still read it. A failed personal-artifact upload must leave the previous revision readable, including after a proxy restart.

The revision-key cache uses named records. An authenticated MLS artifact id such as `__proto__` must not alter object prototypes. The suite also checks that malformed local JSON does not expose stored content in an error.

Run the focused checks from the repository root:

```sh
node --test packages/proxy/test/proxy.test.ts
```

The storage test scans DO values, side keys and blob bytes for an artifact-body marker. It was checked with encryption bypassed: the scan failed on the marker, then passed after encryption was restored. This covers the existing encrypted artifact-body path only. It does not establish privacy for names or metadata.

This historical unsealed artifact test did not protect forum/library/sensemaking metadata. Current sealed-v1 checks above cover those fields, irreversible interview sharing, offers, task exchanges and identity descriptors. They do not establish that the public endpoint has been upgraded or that old plaintext data has been erased.

## Connect the local proxy

The local proxy is the stdio client option for sealed content; the console uses its browser device above. Give its agent the account capability `device.keys` at Worker consent. It starts unchecked, including on reauthorization. Select it and confirm with a registered passkey; a fresh login alone cannot grant it. Ordinary remote coordination clients should leave it off. The automated tests cover proxy bootstrap and a sealed-content round-trip with a Worker agent token; this version has not had a live smoke test.
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

### Check accounts and OAuth hardening

Use synthetic identities and a server built from this revision. These checks do not imply that the live Worker has been updated.

- Start authorization in one browser. Check that consent shows the full client id and redirect host. Copy its consent URL into another signed-in browser; it must be refused. Complete it in the first browser and check the redirect's `iss` parameter.
- Inspect an HTTPS response for `Strict-Transport-Security`. DCR allows five registrations per minute per IP; the sixth must return 429 without blocking another IP or consuming the separate login/authorization/token limit of 30 per minute. Production without either limiter must return 503. Unused DCR clients expire after ten minutes; reaching the anonymous table cap must not block existing-account operations.
- Create two agents for one person. An agent may list, read and narrow only itself, not its sibling. A journey-specific always-allow must not allow the same requester in another journey or exceed the owner's ceiling.
- With a fake upstream in the automated suite, return 503 at refresh: retrying the same refresh token after recovery must succeed. Return 404 instead: access and refresh must be refused without deleting the account, agents or cards. Restore the upstream profile and retry the same refresh token; it must succeed and clear suspension. A real WorkOS webhook is not wired yet, so upstream deletion is currently detected at refresh, not immediately.
- Confirm the new `AccountsPartitionedV1` binding only in a reviewed dry-run. It starts a fresh account directory; old classes and data remain. Do not deploy or delete data as part of this test.

### Check nicknames and email invitations

These checks cover newer source changes, not the live run recorded above. Use a server built from this revision.

After B has called `account_read` once, A can invite B with `journey_invite` using `journeyId` and B's synthetic WorkOS `email` instead of `personId`. Supply exactly one of the two; email matching ignores case. B then calls `journey_join`. Only guides may invite. Repeat with an unknown email and an already-invited email: each must return the same `{ journeyId, accepted: true }` acknowledgement. Admission, refusal, role and guide changes still require `personId`.

Change B's nickname again and check that A's next `journey_read` shows it without rejoining. Other people's emails must not appear in journey results; a profile with only an email uses `Wayfinding member` until a nickname is set. Neither the invitation response nor a later `journey_read` may disclose whether an invited email has an account. Pending invitations are visible only to the invitee; join requests remain visible.

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
