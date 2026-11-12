# Decisions

One entry per decision about the Wayfinding rewrite. Newest last. Each entry names who decided, why, and where the full record is.

"Dan" is Dan Blah, the project lead. "Architect" is the engineering agent that wrote the rewrite design. Plan files are under `.work/drafts/`.

A decision stands until a later entry replaces it. To change one, add a new entry that names the one it replaces.

## Rewrite plan

### 1. Start clean, with no migration

- **Decided by:** Dan
- **What:** take down the old app and remove its code from `main`. Carry no legacy code forward. Keep the old stored data, but do not migrate it.
- **Why:** the old app carried open review findings, and the new design replaces its web interface with MCP Apps.
- **Source:** `.work/drafts/rewrite.md`, question Q2; commit `403a84e`.

### 2. Take the old app down with no holding notice

- **Decided by:** Dan
- **What:** edit the website as if the tool had never existed.
- **Source:** `.work/drafts/rewrite.md`, stage 0; commit `8062244`. The website change is the site repository's pull request 7.

### 3. Build rules and the MCP server first

- **Decided by:** Dan
- **What:** stage order is gdp-wired rules, then the MCP server with WorkOS accounts, then content and tools.
- **Source:** `.work/drafts/rewrite.md`, question Q6; commit `403a84e`.

### 4. Use WorkOS AuthKit for accounts and sign-in

- **Decided by:** Dan
- **What:** AuthKit is the OAuth authorisation server. It handles accounts, sign-in, passkeys, client metadata documents and dynamic client registration.
- **Why:** it saves building account and OAuth infrastructure.
- **Source:** `.work/drafts/rewrite.md`, stage 2; commit `8062244`.

### 5. Write the rules in gdp-wired, without pi-intent

- **Decided by:** Dan
- **What:** no intent records, approvals or receipts during the proof of concept. Dan reviews the rules before real users arrive (stage 7).
- **Why:** speed during the proof of concept.
- **Source:** `.work/drafts/rewrite.md`, question Q3; commit `8062244`.

### 6. Prove rules over any stored state, and compile them at build time

- **Decided by:** the rewrite design (Architect)
- **What:** every step over stored state is proved with `proveSteps(..., { from: 'any' })`. Rules are compiled with `compileJs` at build time, committed and hashed. Workers never call `compiled()`.
- **Why:** `gate()` proves only reachable states. `compiled()` uses `new Function`, which Workers refuse.
- **Source:** `.work/drafts/rewrite.md`, "Hard constraints".

### 7. Pin gdp-wired to an exact version

- **Decided by:** the rewrite design
- **What:** pin the exact version with its integrity hash. Every upgrade reruns the proofs.
- **Why:** patch release 0.30.1 changed what a verdict means, and 0.31.0 changed the trusted kernel.
- **Source:** `.work/drafts/rewrite.md`, "Hard constraints".

### 8. Stamp stored state with the rules hash

- **Decided by:** the rewrite plan (question Q4)
- **What:** stored state carries the hash of the generated rules. A changed rules module needs a proved migration, or fresh storage.
- **Why:** gdp-wired has no version API.
- **Source:** `.work/drafts/rewrite.md`, question Q4.

### 9. Keep rule values below 2^53

- **Decided by:** the rewrite plan (question Q5)
- **What:** IDs are interned to small integers, and encoders reject larger values.
- **Source:** `.work/drafts/rewrite.md`, question Q5.

### 10. Use a personal encrypted group for private artifacts

- **Decided by:** Dan (option C)
- **What:** each person has a personal MLS group (the person, their devices and their agents). Private artifacts are encrypted to it, and can be copied or moved into a journey.
- **Replaces:** decision D36, which hid the existence of private artifacts from the server.
- **Source:** `.work/drafts/rewrite.md`, question Q7; commits `400b0ac` and `d4e8136`.

### 11. MLS library

- **Decided by:** Architect
- **What:** the plan was OpenMLS compiled to WebAssembly, with ts-mls only if that build was blocked.
- **Outcome:** the proxy uses ts-mls 1.6.4 (`packages/proxy`), labelled unaudited. The server runs no MLS library.
- **Source:** `.work/drafts/rewrite.md`, question Q1.

### 12. No re-delegation of grants in v1

- **Decided by:** the rewrite design (decision 11), confirmed by Architect
- **What:** a grantee cannot issue grants. The research sketch had allowed 3 levels.
- **Source:** `.work/drafts/rewrite.md`, "Disagreements", item 3.

### 13. Tasks error code

- **Decided by:** the rewrite plan (question Q8)
- **What:** use core MCP code -32021 until the Tasks extension settles.
- **Source:** `.work/drafts/rewrite.md`, question Q8.

### 14. No reviews during the proof of concept

- **Decided by:** Dan
- **What:** no approval waits while building. Dan reviews, and an independent security review runs, before real users or confidential data arrive (stage 7).
- **Source:** Dan, in conversation (2026-10-29).

## Proof of concept

### 15. Host the proof of concept at poc.wayfinding.support

- **Decided by:** this agent
- **What:** the proof of concept runs on the WorkOS staging environment. `app.wayfinding.support` stays dark.
- **Source:** `docs/poc-test-guide.md`.

### 16. Agents use only `unified/` models

- **Decided by:** the rewrite plan
- **Source:** `.work/drafts/rewrite.md`, "Hard constraints".

### 17. Invite by email and show nicknames

- **Decided by:** Dan
- **What:** guides can invite by email. Members see names instead of IDs, and each person can set a nickname.
- **Source:** Dan, in conversation (2026-10-29); commit `cfe2b08`.

## v2

Dan's brief for v2 was to write the spec, build what seems best, and refine later. He also set terms and scope. The design choices below were made by this agent under that brief, and Dan reviews them later. The full text is in `.work/drafts/v2.md`, "Design".

### 18. Keep the terms guide, owner and lead

- **Decided by:** Dan
- **What:** a guide creates and looks after a journey, an owner creates an artifact, and a lead creates a project.
- **Source:** `.work/drafts/v2.md`, "Why"; `docs/ontology.md`.

### 19. Any person capability can go to an agent, but never by default

- **Decided by:** Dan
- **What:** capabilities come from a fixed list with a scope (account or journey). Adding agents, binding clients, changing cards and managing passkeys can never be given to an agent.
- **Source:** `.work/drafts/v2.md`, design 1; `packages/rules/src/capabilities.ts`.

### 20. Only people issue grants

- **Decided by:** this agent, applying decision 12. Dan may reverse it.
- **What:** `grant.issue` can never go on an agent card.
- **Source:** commit `4a6ffd5`.

### 21. Cards narrow freely, and widen only with a passkey

- **Decided by:** this agent
- **What:** an agent's card starts empty. What it may do is: its person holds the capability now, and the card contains it, and both the person and the agent are live. Widening the card needs a WebAuthn assertion over the exact change.
- **Source:** `.work/drafts/v2.md`, design 2.

### 22. A bound client always acts as its agent

- **Decided by:** this agent
- **What:** a person can bind a connected client (an account and OAuth client ID pair) to one agent. That client then always acts as the agent and cannot reach the console.
- **Why:** while an agent's client held its person's token, cards could not be enforced.
- **Source:** `.work/drafts/v2.md`, design 3.

### 23. Host the console on the same Worker

- **Decided by:** this agent
- **What:** pages are served under `/console`. Sign-in uses AuthKit with PKCE. The session cookie lasts 8 hours, and every form carries a CSRF token.
- **Source:** `.work/drafts/v2.md`, design 4.

### 24. Library kinds, labels and visibility

- **Decided by:** Dan set the scope; this agent chose the details
- **What:** 14 artifact kinds and free labels. Visibility is members or private. Text stored on the server is limited to 256 KiB.
- **Source:** `.work/drafts/v2.md`, design 5.

### 25. One forum, with a conversation on every project and artifact

- **Decided by:** Dan set the scope; this agent chose the details
- **What:** boards, topics and posts, plus a conversation on every project and artifact. Posts record whether a person or an agent wrote them.
- **Source:** `.work/drafts/v2.md`, design 6.

### 26. Sensemaking rounds

- **Decided by:** Dan set the scope; this agent chose the details
- **What:** a round moves from planned to open to synthesising to closed. Interviews are private to their member. Contributions are credited to the person. `round_next` plans the next round.
- **Source:** `.work/drafts/v2.md`, design 7; `docs/ontology.md`.

### 27. Proof-of-concept privacy exception

- **Decided by:** this agent
- **What:** the server can read posts, interviews and library text, so cloud clients can use them. The pages say so. Real users stay blocked until stage 7.
- **Source:** `.work/drafts/v2.md`, design 9.

### 28. Reset proof-of-concept data on rule changes

- **Decided by:** this agent
- **What:** when the rules hash changes, deploy fresh storage classes instead of migrating.
- **Source:** commit `0ea3b13`.

### 29. Show passkeys by provider name and last use

- **Decided by:** Dan asked; this agent chose how
- **What:** each passkey shows its provider name (looked up from the AAGUID the passkey reports) or the person's own name for it. The raw ID is hidden. The list shows when each passkey was added and last used, and the page confirms when a passkey was used.
- **Source:** commit `a3f960f`.

### 30. Merge freely while in prototype mode

- **Decided by:** Dan (2026-11-03)
- **What:** this agent merges when the work looks good and complete. The rewrite merged to `main` as `ca48bdd`.

### 31. The Worker is the authorization server; agents are created at sign-in

- **Decided by:** Dan
- **What:** MCP clients authorise with the Worker at the resource origin. AuthKit remains the upstream sign-in provider for the console. After a sign-in no more than ten minutes old, the person names the agent and chooses its capabilities and journeys. Allow creates or updates the live agent for that person and client, signs its card and binds the client through the existing rules. No separate create-agent or console bind step remains.
- **Tokens:** single-use codes last 60 seconds and require S256 PKCE. Opaque access tokens last one hour; rotating refresh tokens last up to 30 days. Accounts stores token hashes, not bearer values. Reusing a rotated refresh token revokes its family. Removing an agent revokes tokens and removes journey memberships. Calls always use the bound agent and its current card.
- **Confirmation:** fresh upstream login confirms ordinary consent. The `device.keys` exception in decision 32 always needs a passkey. Console widening still needs a passkey; narrowing, renaming, journey changes and deletion do not. `grant.issue` and the never-assignable actions remain forbidden.
- **Supersedes:** decision 4's choice of AuthKit as the MCP authorization server, decision 21's passkey-only confirmation at sign-in, and decision 22's separate console binding flow. The rule that a bound client always acts as its agent remains. Existing Durable Object classes, rules hashes and journey data stay unchanged. Old AuthKit MCP tokens must reauthorise once.
- **Source:** Dan's agent-at-auth brief; `packages/mcp/src/oauth.ts` and `packages/mcp/src/oauth-store.ts`.

### 32. Device keys require explicit, passkey-confirmed consent

- **Decided by:** Dan set the boundary; this agent chose the binding and compatibility path.
- **What:** `device.keys` is account capability 20. A person can use the private account profile, personal group, key-package and personal relay operations as before. An agent also needs `device.keys` on its live card. The local proxy remains required for sealed artifact content; ordinary remote clients do not need device authority.
- **Confirmation:** consent always shows this capability unchecked. Selecting it requires a registered passkey with user verification, even on first consent after a fresh login. Accounts stores a single-use challenge lasting up to five minutes bound to the person, the exact pending OAuth request (client, redirect, PKCE and state), and the proposed name, capabilities and journeys. Changing those fields, replaying the assertion or letting it expire cannot issue tokens. Console widening reuses its existing passkey check.
- **Compatibility:** preserve existing Accounts and Journeys data. Accept only the preceding card-module hash with every other rules hash unchanged. Capability ids 0–19 and the card state shape retain their meaning. Old unknown cells and map defaults cannot grant the new capability. Reads do not write; the next successful write stores the current stamp. Unknown rules remain refused. No new Durable Object classes or storage reset.
- **Supersedes:** decision 28's reset policy for this additive card change, and decision 31's login-only confirmation for `device.keys`.
- **Source:** `packages/mcp/src/accounts.ts`, `packages/mcp/src/oauth.ts`, `packages/mcp/src/rules.ts`; regression tests in `packages/mcp/test/oauth-as.test.ts` and `packages/mcp/test/device-compatibility.test.ts`.

### 33. Offers turn advertised work into bounded requests

- **Decided by:** Dan approved the offer model; this agent chose the server-stage details.
- **What:** an agent advertises named offers with bounded descriptions, examples and input/output schemas. A request validates input before any task is saved and records the offer version. Ordered admission rules allow, hold or deny; a deny leaves no task. Per-requester limits hold excess requests. The default Members preset allows people and holds agents. Open allows members; Ask me holds everyone except the owner.
- **Authority:** only the owner edits by default. `offer.manage` permits an agent to define its own offers, as drafts unless the owner permits publication without review. The owner sets an admission ceiling and an optional rolling 24-hour request cap across all that agent’s offers and journeys. Raising that ceiling requires a passkey; an agent cannot raise it. Only the owner or an authorised agent with `offer.decide` may approve or decline a held request. These decisions never widen a card. Every request has a deadline and round cap.
- **Shared allowances:** per-requester limits apply to one person or agent and one offer across every journey. The daily ceiling covers every offer of the offering agent. Both count created requests, including held, completed and cancelled requests, in rolling windows. Denied or invalid requests do not count.
- **Reservation protocol:** the creating Journey generates a task id, checks membership and validates input. Before saving the task, it reserves that id in the owning Accounts authority. Accounts serializes reservations with offer and settings edits, checks the offer version, and records an allow or hold decision using stable requester ids. Repeating the same reservation returns the saved decision; reusing its id with different fields is refused. Accounts retains one week of receipts, the longest supported window, so editing a policy cannot reset recent usage. A definite failure before the journey transaction commits releases the reservation. A committed task keeps it, even if notification fails. A lost reply, crash or uncertain release keeps it until the window expires: this may hold an extra request, but cannot grant extra admission. There is no cross-object transaction or automatic release on a timer.
- **Boundary:** this stage stores content separately from routing and admission metadata, but does not encrypt it. Task exchange, sealed offers/cards and a browser MLS device are later stages. Use synthetic data only. Released MCP Apps views remain byte-for-byte unchanged; only the console gains offer and approval controls.
- **Source:** `.work/drafts/offers.md`; `packages/mcp/src/offers.ts` and offer regression tests.

### 34. Per-journey offers use switches and admission permits

- **Scope:** section 6 of `.work/drafts/sealing.md` only. This entry does not adopt the draft's content sealing, browser device or storage reset. Definitions remain server-readable in `Offer.content`; the journey row has a marked extension point for a later encrypted definition. Synthetic data only.
- **Availability:** explicit `journeySettings` replaces `journeys: 'all' | string[]`. Each offer starts Off everywhere, including journeys joined later. Each strict row contains `enabled` and an optional positive `maxRequestsPerDay`; there are at most 128 rows. Published status, an enabled row and current membership/card authority are all required. Disabling stops discovery, new requests and approval, but does not cancel admitted work.
- **Authority and versions:** owners can change one row with `offer_journey_set`, its current `expectedVersion`, `enabled`, and an optional limit. Omission preserves a limit; `clearLimit: true` restores inheritance. Agents with `offer.manage` may narrow or disable only, through either edit command. A journey value above a finite agent ceiling is refused. Lowering that ceiling clamps stored row limits and advances affected offer versions without resetting usage. Definition edits advance `contentRevision` as well as `version`; policy edits advance only `version`.
- **Permits:** the legacy API name `maxRequestsPerDay` now means admitted tasks per rolling 24 hours. The owner ceiling covers every offer and journey of one agent; a row ceiling covers one offer in one journey across all requesters. Accounts serializes edits and permit issuance. Allow and approve obtain one idempotent permit bound to the original request. Automatic, standing and manual approval cannot bypass either finite cap: excess remains held. Approval checks current publication and switch state. A reduction below issued usage blocks new permits until the window clears; it does not revoke admitted work.
- **Receipts and failures:** per-requester policy still counts created requests, including held or ended requests, for one requester and offer across every journey. Receipts and permits are separate ledgers, retained for one week. Cancellation and completion do not refund permits. A definite Journey precommit failure can release its permit; a failed approval preserves its original receipt. Lost replies retain capacity and retries cannot issue another permit. Approvals with an expired receipt fail closed.
- **Synthetic migration:** legacy wildcard scopes become explicit Off entries for the agent's recorded journeys; legacy lists become explicit Off entries for those ids, bounded to 128. No legacy scope is enabled automatically. Owners must review and turn it On. Old approvals had no separate ledger, so every retained legacy receipt conservatively seeds a permit at migration time, even if it was held. This can hold extra work for 24 hours; it cannot grant extra capacity. No content is encrypted, deleted or reset by this migration.
- **Supersedes:** decision 33's daily created-request accounting only; its per-requester accounting and authority checks remain. The console shows the agent ceiling, On/Off rows, inherited or per-day limits, admitted usage and held counts.
- **Source:** `packages/mcp/src/offers.ts`, `packages/mcp/src/agent-offers.ts`, `packages/mcp/src/accounts.ts`, `packages/mcp/src/tasks.ts`; `packages/mcp/test/offer-journeys.test.ts` and console tests.

### 35. Seal all non-routing content; scope offers per journey

**Status:** staged synthetic-only implementation. The current privacy boundary is described in `docs/poc-test-guide.md`. Interview sharing is resolved for the PoC below.

- **Decided by:** Dan (2026-11-11) set the encryption boundary and per-journey offer switches. The PoC group, sharing and budget choices in `.work/drafts/sealing.md` are resolved below. Browser recovery choices are recorded below. Reset and launch reviews remain separate work.
- **What:** content not needed for server routing, authorization, admission, bounded storage or coordination laws is encrypted at the device using MLS audiences. This includes post/topic/board text, interviews, contributions, library metadata and versions, project/journey names and purposes, account/card descriptions, offer schemas/instructions and task requests/results/conversations. Descriptive copies and search queries stay off the server too. Authority/capabilities, ownership, memberships, lifecycle/version counters, deadlines, admission policy and byte accounting remain clear and enforced server-side.
- **Groups:** journey material uses the journey group; private interviews and task exchange use narrower groups; private account material uses the personal group. Removing a device/person/agent revokes its leaves before new content. New versions never reuse keys known to a removed member. `device.keys` still needs explicit passkey-confirmed consent and never grants unrelated authority.
- **Offers:** each offer has explicit on/off settings per journey and may set a lower journey limit. No journey override or approval may bypass the agent-wide hard ceiling. Daily ceilings count idempotent admission permits issued on allow/approve in a rolling 24-hour window; held requests without a permit cannot execute. Both scopes are checked at reservation and approval, while per-requester policy retains created-request receipts.
- **Clients:** proxy/browser validate decrypted content and schemas. The server accepts bounded envelopes, never plaintext content. Search is device-side. Until the browser MLS device is enrolled/unlocked, the console shows ids/status only. A PRF passkey or recovery code protects browser keys; the hosted JavaScript trust limit is disclosed.
- **PoC:** use a new sealed-only storage generation rather than silently migrating plaintext. Keep the old classes and data. Reset/deletion needs separate verification and authority; switching bindings is not a wipe. ts-mls remains unaudited and the rule/security review gate still blocks real confidential data.
- **Supersedes:** `.work/drafts/v2.md` design item 9 and decision 27's server-readable PoC privacy exception; decision 33's plaintext content boundary and wildcard offer-journey scope. Decision 9's numeric bound, decision 20's person-only grants and decision 32's explicit device authority remain. Adoption is staged; existing plaintext paths remain until replaced, not made private by this decision entry.
- **Source:** Dan's sealing/per-journey-offers brief (2026-11-11); `.work/drafts/sealing.md`.
- **Resolved for the PoC:**
  - Interview sharing is irreversible publication to the journey, including future readers and later shared updates; only the private workspace stays in I. Commit private/public updates atomically.
  - Retain at most 4,096 messages and 32 MiB ciphertext per group without silent eviction. Preparation/upload lifetime: 10 minutes. Offline checkpoint lifetime: 30 days. Newcomers receive only entitled live retained history; exhausted budgets refuse writes.
  - Agents need explicit live read plus `device.keys` to post sealed content. Never silently add read; other agents remain metadata-only with an actionable refusal.
  - Authenticated device binding is implemented where feasible. Device trust hardening, independent security review and ts-mls audit block real-data launch, not synthetic-only implementation.
  - Browser devices now reuse the proxy's MLS/decrypt/schema/search pipeline in a reproducible ES-module bundle. The console supports private forum/library/round/task/card/profile/offer reads, local search and sealed post/library/profile/card/offer/decision writes. Locked pages retain ids/status only. Fresh UV passkey enrollment binds the exact person/browser/device/public package and admission remains explicit. A listed browser is revocable through the existing multi-leaf revocation fence.
  - Browser private state and caches use an encrypted IndexedDB vault, a nonextractable random AES-GCM data key and PRF-derived HKDF wrapping bound to origin/person/browser id/format. Passkey registration requests PRF. An independent, high-entropy recovery code wraps the same key with PBKDF2-SHA-256 (210,000 iterations); show it once and require saved-code confirmation even when PRF works. Unsupported PRF uses the code. Recovery opens existing local storage, not a missing vault or a new browser; there is no server backup, escrow or ratchet import. A lost browser needs fresh live-member admission. Losing all devices and recovery material loses the content; account recovery is not key recovery. A lost wrapping passkey cannot authorize a new audience package; use a new device admitted by a surviving member. A live browser's wrapping credential cannot be deleted until its leaves are revoked.
  - The whole unlocked session holds an origin/person Web Lock; writes commit the encrypted state before I/O. Lock/logout/pagehide clears in-memory access and decrypted DOM, and pending commits retain the writer fence until drained. Strict CSP and bundle SRI forbid inline/eval and external code. They do not protect against the hosting Worker replacing both page and policy. Reset/deletion, deployment and data migration remain unauthorised.
  - Envelope v1 accepts only its fixed content type, canonical base64 and the current audience/epoch. Limits: 1 MiB envelope, 64 KiB device package, 9 MiB local payload, 10 MiB encrypted upload, 100 records/4 MiB per listing page, 1,024 content records, 128 groups and 128 active preparation tickets per journey, 128 devices per group. A separate 32 MiB journey upload budget includes expired, uncollected uploads; no cleanup or deletion is performed.
  - Current source seals forum/library/sensemaking and journey/project names and purposes, with J, owner-only P and interview I audiences. Large bodies use fresh revision keys. Assigned interviews materialize client-side from a pinned source; contributions remain immutable attributed records and clients compose the synthesis. Each item edit advances its content revision, including metadata-only edits.
  - Final-write recovery retains the advanced ratchets and exact pending ciphertext, checks the commit receipt and retries only that ciphertext. Ambiguous handshake/history delivery fails closed; it never restores a ratchet snapshot. A new device discovers the existing personal workspace through the authenticated profile descriptor and still needs admission from a surviving member. Browser storage reloads the latest committed vault under an origin/person Web Lock; leaving or locking retains the fence until pending writes drain.
  - Offer definitions have an immutable owner-private P source and explicit J copies at the same `contentRevision`. Discovery requires the matching publication, and queries/tags stay device-local. New sealed offer ids are opaque `offer-<UUIDv4>` values; omitting the id lets the proxy generate one. Console metadata controls cannot encrypt a missing publication.
  - Each task has T, pinned to the authenticated offer publication when applicable. Key admission precedes named/offered task creation or claiming; preparation alone saves no task or allowance. Input, output, input requests/answers, decline/failure reasons, name and task conversation are sealed. Other journey members receive no task content. Status, ids, version/reference, deadlines, round caps and admission accounting stay server-readable.
  - Both endpoints validate the pinned contract. Requesters check input before sealing; receivers check the signed snapshot and opened input/output; producers check output. Unschematized output still has the JSON size/depth/node budget. Invalid input can be failed with a sealed reason. MCP Tasks keeps its extension checks and status mapping; plaintext `tasks/update` input responses are refused. The PoC uses local sealed `task_step` actions for input requests, answers and failure.
  - Account name/nickname/email and device/passkey labels use P, as do card name/client name. Each revision may explicitly publish nickname-only profile and name/client-name card copies to selected J audiences. Current alias selection uses authenticated pointers; withdrawal cannot erase old ciphertext. Descriptive edits never grant capabilities.
  - AuthKit profile fields are transient before device enrollment. Accounts stores opaque id labels and an HMAC of trimmed, lower-case authenticated email for invitations; its server-held key does not hide email from the live server. Editing encrypted profile email does not change authenticated routing. OAuth persists only the fixed `MCP client` label; console/passkey authority controls use ids and refuse raw descriptive edits. Unsealed account state is refused without migration or deletion. P uses the proxy's device-local personal-workspace journey; creating that workspace requires `journey.create` as well as normal action authority and read/device keys. No bootstrap grant or key admission is implicit; authenticated descriptor pointers provide cross-device workspace discovery.

### 36. Agents manage only their own cards

- **Decided by:** hardening task, security finding F14.
- **What:** a bound agent can list and read only its own card, and can narrow or withdraw only that card. The person can still manage every owned agent.

### 37. Standing offer decisions apply to one journey

- **Decided by:** hardening task, security finding F13.
- **What:** standing decisions affect only the journey where the task was decided. Agent-created allows remain bounded by the owner’s admission ceiling, including later ceiling reductions. Manual approval still admits only the selected task.


### 38. Invitations do not reveal account existence

- Email invitations return the same acknowledgement for unknown emails, existing accounts and repeat invitations. Only guides may send them. Joining still proves that the invitee has an account and a pending invitation.
- Every journey RPC checks the account directory before allocating a Durable Object for its id. Device-binding lookup scope remains open because peer and historical signature verification need a shared client/server contract.

### 39. Anonymous sign-in cannot consume a global login budget

- Pre-authentication login state and PKCE verifier live in the signed, expiring, HttpOnly cookie. Only a successful callback leaves a short-lived replay tombstone on the server.
- Login, client registration, authorization and token routes use Cloudflare's per-IP limiter. Production refuses these routes if the limiter or trusted IP is unavailable. There is no shared anonymous client or pending-request count cap. Unused DCR clients expire after one day.

### 40. Consent identifies and binds the requesting client

- Consent shows the full client id and redirect host, including when the client display name is sealed. The initiating browser's HttpOnly cookie must match the saved request on every consent and passkey operation.
- OAuth authorization responses include the issuer. Replaying a correctly bound, already-used code revokes its token family. Client metadata is cached for five minutes; errors are not cached. HTTPS responses carry HSTS.

### 41. Account storage is partitioned without deleting the old generation

- `AccountsPartitionedV1` stores separate account, hashed-token, client, request and permit rows. Delta writes and the write-authority fence share one transaction. Access-token verification reads its token, account and rule metadata without rewriting them.
- Token and unresolved write-permit budgets apply per account. Other account operations still assemble the tables; this is not per-account Durable Object sharding.
- The new class uses a fresh namespace. The old account classes and their data remain. Switching bindings is not a data migration or deletion, and requires the normal deployment gate.

### 42. Refresh checks upstream account liveness

- Refresh verifies that the WorkOS user still exists before rotating credentials. Only a confirmed upstream 404 tombstones the account; an outage returns `temporarily_unavailable` without consuming the refresh token.
- Tombstoning withdraws every owned agent and prevents account resurrection. Prompt webhook offboarding is not implemented yet; a signed user-deleted webhook is still required before this finding is complete.

## Open

- **Remaining sealing work:** device trust hardening, independent security review, ts-mls audit and browser distribution assurance remain launch blockers. Forum, library, sensemaking, offers, tasks and identity descriptors use sealed-v1. The console now has an opt-in browser encryption device, with ids/placeholders while locked. Nothing in this change deploys, resets, migrates or erases old plaintext data.
- **Stage 7, review:** not done. Dan's formal review of the rules and an independent security review must pass before real users or confidential data arrive.
- **Dates:** the rewrite plan dates some of Dan's decisions 2026-11-01, but the commits that record them are dated 2026-10-29. The commit dates are what Git records.
