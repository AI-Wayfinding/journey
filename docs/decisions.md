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
- **Confirmation:** fresh upstream login is the person's assertion at consent. Console widening still needs a passkey; narrowing, renaming, journey changes and deletion do not. `grant.issue` and the never-assignable actions remain forbidden.
- **Supersedes:** decision 4's choice of AuthKit as the MCP authorization server, decision 21's passkey-only confirmation at sign-in, and decision 22's separate console binding flow. The rule that a bound client always acts as its agent remains. Existing Durable Object classes, rules hashes and journey data stay unchanged. Old AuthKit MCP tokens must reauthorise once.
- **Source:** Dan's agent-at-auth brief; `packages/mcp/src/oauth.ts` and `packages/mcp/src/oauth-store.ts`.

## Open

- **Stage 6, cloud-client opt-in:** not built.
- **Stage 7, review:** not done. Dan's formal review of the rules and an independent security review must pass before real users or confidential data arrive.
- **Dates:** the rewrite plan dates some of Dan's decisions 2026-11-01, but the commits that record them are dated 2026-10-29. The commit dates are what Git records.
