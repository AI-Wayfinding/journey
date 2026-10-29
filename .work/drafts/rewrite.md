# Wayfinding rewrite: MCP server, MCP Apps, gdp-wired rules, MLS

## Summary <!-- work:summary -->
Rebuild Wayfinding as a public MCP server at app.wayfinding.support, as recorded in the engineering design `designs/wayfinding-rewrite/design.md` (Architect and Dan, 2026-10-29). People and agents reach journeys, projects, shared artifacts, agent cards, grants and tasks through MCP tools. People see MCP Apps views; the only web page is sign-in and consent. Every coordination change is checked by gdp-wired rules compiled to JavaScript at build time. Artifact content stays private: per-artifact keys travel over MLS (RFC 9420), held by a local enclave proxy for local clients and by the sign-in page; the server holds no MLS library and only relays and orders commits. Coordination data is plaintext to the server, as the design's security promise states. This draft is a delivery plan in eight stages. It is not approval to build, and no stage may hold real confidential data until stage 7's review passes.

## Why <!-- work:rationale -->
The current app (stages 0 to 3 of the 2026-09 plan, 112 Bend laws, browser plus CLI/MCP client) carries the 2026-09-24 review findings C1, H1 to H3, M1, M2 and L1, and its human interface is a web app the design now replaces with MCP Apps. The design fixes thirteen decisions; this plan sequences them and gives each stage an observable definition of done.

Hard constraints, from the assignment and the design:
- No `gate()` on stored state. `gate()` proves reachable states only. Every step over stored state uses `proveSteps(rule, laws, stepLaws, { from: 'any' })` at build time and requires `proven && checked && !assumes`.
- gdp-wired rules are compiled with `compileJs` at build time, committed, and hashed. Workers never call `compiled()` (it uses `new Function`, which Workers and the App CSP refuse). The prover is a devDependency only.
- gdp-wired is pinned to an exact version with an integrity hash. Each bump reruns the proofs, `crossCheck` and broken-variant tests, and diffs the generated module. Reason: 0.30.1 (a patch) changed verdict meaning and 0.31.0 changed the trusted kernel.
- Agents and delegates on this work use `unified/` models only.
- No real confidential data, including Reset material, enters any deployment until stage 7 passes. Test journeys use synthetic content.
- `packages/core`-equivalent code runs unchanged in Node, browsers and Workers: Web Crypto only.

Out of scope, from design section 8: A2A, an internal agent registry beyond cards, a backend web UI, passkeys inside App views, Spindle work, and a transparency log (deferred past v1; C1 and H1 are accepted and labelled).

The existing stage 3 to 7 drafts and specs in `.work/` are superseded by this plan once it is approved. They stay in the tree as the record of decisions D1 to D45. Decisions this plan keeps unchanged: D27 interfaces in step (now MCP tools, Apps, proxy), D30 users, D31 extended by design decision 5, D41 joining, D45 agents act within their person's live capabilities.

### Stages

Each stage is one pi-work node group. A stage is done when its acceptance criterion below passes, run by the dispatching session with `work_verify` against an explicit worktree and commit.

0. **Foundations.** New package layout beside the old one (`packages/rules-gdp`, `packages/mcp`, `packages/proxy`, `packages/apps`). gdp-wired pinned exactly. Build step generates `rules.generated.js` with `compileJs`, writes its SHA-256 and the gdp-wired version and integrity to `rules.lock.json`, and fails if the committed module differs. Small input encoders intern IDs to integers and assert every value is a safe integer (Q5). CI on Node 20+ runs `proveSteps` with `{ from: 'any' }` for every step law, broken-variant tests that must fail, and `crossCheck`; Lean `lake build` runs nightly and on any gdp-wired bump.
1. **Coordination rules.** gdp-wired models for membership, roles, guides, admission and settings, removal (epochs re-derived from MLS commits in stage 3), projects, shared-artifact metadata and versions, agent cards, grants, tasks and D41 joining. Port the meaning of the Bend laws that do not read content; turn the ~20 fixed-value laws into ordinary tests; leave signatures, hashes, key wrapping, time and list order to host code. The 37 private-vault laws are held pending decision `private-artifacts` (design Q7). Laws are sketched here and stay unapproved until pi-intent 0.7.0 ships a gdp-wired model kind (Q3); then each record goes through intent record, law approval, Jev receipt and conformance.
2. **MCP server and auth.** Cloudflare Worker with one Durable Object per journey and R2 for encrypted blobs. `createMcpHandler` from the TypeScript SDK v2 with the journey DO as event bus; serves 2026-07-28 and 2025-11-25 stateless. OAuth resource server (RFC 9728 metadata, RFC 8707 audience, `insufficient_scope` step-up) with workers-oauth-provider 1.2.4 as authorisation server, CIMD (advertising `client_id_metadata_document_supported` and `none`) and DCR, PKCE S256. Sign-in and consent page with passkeys. Every coordination tool steps the compiled rules inside the DO before writing. Coordination only: no artifact content yet.
3. **MLS and the local enclave proxy.** MLS group per journey, using OpenMLS compiled to WASM in the proxy and the sign-in page, behind an `MlsGroup` interface and labelled unaudited (Q1); ts-mls only if the WASM build is blocked. The server runs no MLS library: it relays and orders commits. One leaf per device. The proxy, grown from `packages/client`, is a local stdio MCP server that holds MLS state and keys and forwards coordination calls to the public server. Per-artifact content keys are shared over MLS so new members receive the history they are entitled to. Artifact create, version, read and delete with encrypted blobs in R2. Removal and epoch rules check MLS commits.
4. **MCP Apps.** Versioned `ui://` views (`text/html;profile=mcp-app`) for journey overview, artifacts, projects, members, agent cards and grants, tasks. App-only tools carry the human-origin hint. Passkey actions leave the App through `ui/open-link` to the sign-in page. Views state that the model provider sees tool results.
5. **Tasks and agent cards in use.** Server task store with an inbox resource and `subscriptions/listen`; offline agents poll. MCP Tasks extension (SEP-2663) handlers `tasks/get`, `tasks/update`, `tasks/cancel`, only when the request declares the extension, durable before reply, unguessable IDs. Errors use core MCP code -32021 until the extension settles (design Q8). Tasks end on round cap and time limit (decision 10). Agent card limits signed once by the person; effective capability computed at use as person capability AND card limit AND live; no re-delegation in v1.
6. **Cloud-client opt-in.** A journey may opt in to server-side decryption so cloud clients (Claude, ChatGPT) can read content. The opt-in is a signed coordination action under the rules, visible to every member in Apps and proxy, and reversible for future content only.
7. **Review and cutover.** Independent security review of the rewrite against design section 5. Site `public/agents/start.md` and `install.md` replaced in the same change as cutover. Cutover per decision `migration`. Only after the review passes may real confidential data enter.

### Open questions from design section 7

- **Q1 MLS library.** Resolved by Architect: OpenMLS compiled to WASM in the local proxy and the sign-in page, labelled unaudited; ts-mls only if the WASM build is blocked. No public audit was found for any candidate. The server needs no MLS library.
- **Q2 migration or clean start.** Routed to Dan; recommendation in decision `migration`.
- **Q3 pi-intent 0.7.0.** Routed: owned by another session; hypha-manager reports when 0.7.0 lands. Laws stay as unapproved sketches below until then.
- **Q4 rule versioning.** Resolved: every stored DO state and every log entry carries `rules: <sha256 of rules.generated.js>`. The DO steps only state whose `rules` hash equals the running module. A changed module ships with an explicit migration step proved `{ from: 'any' }` over the old state shape, or the deploy fails. Reason: gdp-wired has no version or fingerprint API, and the hash already exists from stage 0.
- **Q5 values below 2^53.** Resolved: no bigint in rule state. Encoders intern IDs, members and artifacts to small integers per journey; sequence numbers and epochs are safe integers; timestamps stay host-side. Encoders reject anything else before stepping, and a test supplies 2^53 and expects rejection.
- **Q6 stage order.** Routed to Dan; recommendation in decision `stage-order`.
- **Q7 author-private artifacts.** Routed to Dan; options in decision `private-artifacts`.
- **Q8 Tasks error code.** Resolved for now: follow core MCP -32021 until SEP-2663 settles; stage 5 tests both clients.

### Law sketches (unapproved, for pi-intent 0.7.0)

These are shapes, not laws. Each becomes a numbered clause in an intent record once 0.7.0 exists.
- Grants: a grant names grantor, grantee, command, resource, expiry and uses left. Issuing requires grantor holds the capability and is live. Using requires grant live, not expired, uses left above zero; use decrements. Revocation is terminal. Depth is 0 in v1: a grantee cannot issue from a grant (design decision 11; research sketch used depth 3).
- Agent cards: card limits are signed by the adding person once. Effective capability of an agent equals person capability AND card limit AND person live AND agent live. An agent card cannot widen on edit without a new person signature.
- Tasks: states open, claimed, in-round, done, expired, cancelled. A round may start only when rounds used below max rounds and now below deadline. Done, expired and cancelled are terminal. Every task reaches a terminal state because both caps are finite.
- Joining (D41): join policy per journey; a join request becomes membership only by a guide action or an auto-join policy the guide set; removal ends every grant and agent of the removed person in the same step.
- Opt-in (stage 6): enabling server-side decryption requires a guide and records who and when; disabling stops future content only.

### Disagreements and contradictions found

1. **Author-private artifacts.** D36 (stage 3, on main at 7927979) hid even the existence of private artifacts from the server; the first design draft moved their 37 laws to the server. Now design Q7, awaiting Dan; see decision `private-artifacts`. Design section 5 now counts artifact names as encrypted content.
2. **Step-up in stateless legacy clients.** Resolved in design section 3: cloud clients step up through `insufficient_scope` and the sign-in page; URL elicitation is a bonus where supported.
3. **Grant depth.** The research sketch bounds re-delegation at depth 3; design decision 11 forbids re-delegation in v1. The plan follows the design (confirmed by Architect).
4. **Tasks error code.** Now design Q8: core -32021 until the extension settles.
5. **Repository instructions.** `AGENTS.md` requires Bend and `bend PROOF.bend`. Stage 0 must update it for gdp-wired, or workers will follow the old rule.

## Open decisions <!-- work:decisions -->
- migration: Clean start or migration from the current app?
  Recommendation: clean start. Users are Dan and Reset only (D30); data has been wiped twice already; content is end-to-end encrypted, so only member devices could migrate it; both the log format and the key scheme change (MLS, gdp-wired). Offer each member a local export of their artifacts with the existing `exportArtifactJourney` before the old app closes, and no automatic import. Migration would mean a converter for every signed log type plus key rewrapping into MLS, for at most a few journeys.
  tripwire: Before stage 7 cutover is planned; stage 0 to 6 do not depend on it.
  decides: Dan, via hypha-manager
- stage-order: Rules and MCP surface first, or MLS first?
  Recommendation: rules and MCP first (the order above). Coordination is plaintext by design, so stages 1 and 2 can be built, proved and tried with synthetic journeys without any encryption decision. That gives time for Q1 (MLS library audit) and Q3 (pi-intent 0.7.0) to settle. Risk: artifact formats depend on MLS; stage 0 fixes the `MlsGroup` and per-artifact key interfaces so stage 2 does not guess.
  tripwire: Before stage 1 is dispatched.
  decides: Dan, via hypha-manager
- private-artifacts: How do author-private artifacts (D36, stage 3 on main) carry into the rewrite? (design Q7)
  Option A: drop for v1; private means MLS-encrypted among journey members only. Option B: keep a client-only private vault in the proxy with its 37 laws compiled for the client, never the server. Option C (Architect recommends): each person has their own MLS group of that person and their agents; private artifacts are encrypted to it; the server sees only an opaque blob and its size; other members see nothing. C retires most of the 37 private-vault laws and the D46 padding.
  tripwire: Before stage 1 law sketches are finalised.
  decides: Dan, via hypha-manager
- rules-approval: Can the stage 1 law sketches become approved laws?
  Blocked until pi-intent 0.7.0 releases the gdp-wired model kind; hypha-manager reports the release.
  tripwire: Before stage 1 is called done.
  decides: Dan approves laws; Architect owns the pi-intent dependency

## Acceptance criteria <!-- work:criteria -->
- foundations: With gdp-wired pinned exactly, `npm run build:rules` regenerates `rules.generated.js` byte-identical to the committed file and `rules.lock.json` matches its SHA-256 and the gdp-wired version and integrity; CI runs `proveSteps` with `{ from: 'any' }` for every step law and fails if any result lacks `proven && checked && !assumes`; every broken variant fails; a repository search finds no `gate(` or `compiled(` outside tests; encoders reject a value of 2^53; `AGENTS.md` describes the gdp-wired workflow.
- coordination-rules: For membership, roles, admission, removal, projects, shared-artifact metadata, agent cards, grants (depth 0), tasks and D41 joining, each intent record is approved, its laws have a passing pi-intent 0.7.0 receipt that records the gdp-wired version and hash, and conformance shows the compiled module matches the model with a broken model differing; no law reads artifact content.
- mcp-server: Against local workerd with synthetic journeys, an MCP client on 2026-07-28 and one on 2025-11-25 stateless both complete OAuth (CIMD and DCR, PKCE S256), discover the resource metadata, and run every coordination tool; each write steps the compiled rules inside the journey DO and a rule-denied action changes no stored state; a missing scope returns `insufficient_scope`; stored state carries the rules hash and the DO refuses a mismatched hash.
- mls-proxy: With two members on separate devices through the local proxy, an artifact created by one is readable by the other, a member added later reads entitled history, a removed member cannot read content created after removal, the server's stored data contains no plaintext content or content key, and OpenMLS-WASM (or ts-mls if the WASM build is blocked) sits behind the `MlsGroup` interface in the proxy and sign-in page, labelled unaudited, and the server runs no MLS library.
- apps: In an MCP Apps host test harness, every view loads from a versioned `ui://` URI, performs its actions only through tools, opens the sign-in page for passkey actions, and shows the model-provider notice; a view built for an older version still loads.
- tasks-cards: A task created by one member and claimed by an agent moves through rounds and ends at the round cap and, separately, at the deadline; Tasks extension calls work only when declared and errors use code -32021; an agent's effective capability never exceeds its person's live capability or its signed card limit, and an agent cannot issue a grant.
- opt-in: Enabling server-side decryption is a rules-checked guide action visible to every member; a cloud client reads content only after it and not after disabling for content created later.
- review-cutover: An independent review against design section 5 reports no open critical or high finding outside the accepted C1 and H1; site agent instructions match the new service; cutover follows the recorded `migration` decision; only then is real confidential data allowed.
