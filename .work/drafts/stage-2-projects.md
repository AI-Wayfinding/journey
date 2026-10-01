# Stage 2: projects

## Summary <!-- work:summary -->
Deliver projects inside existing private journeys: a purpose, person participation with agents following their adding person, and the states getting started, active, looking for others and archived. Support joining/leaving, project-member purpose/state edits, archive/reopening, zero-or-one project placement per artifact copy and main-list filtering. Deliver browser and CLI/MCP workflows and project-aware read-only agent-link overview pages. Preserve Stage 0 authority and Stage 1 artifacts, attachments and viewers. This is an implementation plan, not implementation approval or passing evidence.

## Why <!-- work:rationale -->
Ontology section 9 Stage 2, the project/participation relationship and access rows, and decision 0001 D5, D16–D20, D27–D28, D30–D31 and D33–D36 define the outcome. Amendments override earlier wording: projects are groupings, not sharing destinations or read-access boundaries; agents follow their adding person's participation. D17 explicitly lets read-only project members edit project purpose/state without ordinary content-write permission. Main at 9becdf6 is the source baseline, with Stage 0 and Stage 1 code present. Ontology approval remains the implementation prerequisite; draft promotion does not grant it.

All access, participation, permission and replay decisions belong in production Bend functions in packages/rules, stated in LAWS.bend and proved by PROOF.bend. TypeScript validates formats, signatures, ciphertext commitments and identity/epoch bindings, copies named fields, encrypts, stores and transports, and projects verified Bend results. Extend scripts/check-bend-boundary.mjs without weakening its existing checks. Signed public ControlProof is the only authority; encrypted project text is display content, never a second action or source of grants. A hostile or careless caller must not join another person, give an agent independent participation, use stale/removed/expired participation, elevate D17 metadata access into artifact creation/edit/comment/deletion/placement or blob staging, gain writes from guide status, replay a stale purpose/state/placement edit, assign multiple or foreign projects, resurrect deleted artifacts, omit a capability to obtain partial content, or smuggle extra fields into storage/output. Pending rotation blocks ordinary content writes, including creation and placement, but not authorized participation or project-metadata controls needed by read-only members. Projects do not change who can read an artifact; existing deletion/recovery exclusions remain. Previously downloaded keys and copies cannot be recalled.

Out of scope: author-private artifacts/existence secrecy (Stage 3); rounds, facilitators, interviews and contributions (Stage 4); HTML/applets (Stage 5); public journeys/listing/joining-policy activation/conversion/cross-journey copies (Stage 6); full shared overview/list/search/show/comments refactoring, full client/link parity and drops (Stage 7). Keep existing private-only admission and person controls, approval-first agent connection, attachment limits, encryption and viewer safety. Preserve the app header/footer. No deployment, provisioning, package publication, real Keychain/journey access or remote action is execution evidence. No purge, historical rewrite, migration checkpoint or legacy trust bootstrap is needed: histories without project actions start with empty project/placement indexes and remain valid.

## Decisions taken

These choices resolve ontology section 9's technical questions without reopening Dan's product decisions. The lead should review them before implementation.

1. **Project identity and text:** a stable journey-scoped ULID identifies a project; the required editable `purpose` is trimmed nonempty plain text, at most 10,000 UTF-8 bytes, with no separate name/owner/guide field. A purpose excerpt labels list/navigation entries and full purpose appears on detail pages. This implements the one text field D16 names without inventing a product naming decision. Creation records its signer/time for provenance, not exclusive control. Project IDs cannot collide with project, artifact, version or comment IDs already used in that journey. No delete control: archive is the specified lifecycle, so references and recorded history remain stable.
2. **Signed project format:** add `project.create`, `project.purpose`, `project.state`, `project.join`, `project.leave` and `artifact.project` to the existing ControlProof chain, all with exactly `format:'project-v1'` and `project` (ULID, except nullable in `artifact.project`). Create has `purposeHash` and `state:'getting-started'`; purpose has `purposeHash` and `predecessor`; state has `state` and `predecessor`; join/leave have `member` and `predecessor`; artifact.project has `artifact`, immutable `author`, actual `actor` and `predecessor`. The common proof actor is the real signer; the duplicated placement actor must match it. `predecessor` is the last relevant proof sequence, or null for an initially absent participation/placement. Purpose/state share one project revision (creation sequence then latest purpose/state sequence), participation has one revision per project/person pair, and placement has one revision per stable artifact. Sequence values are safe nonnegative integers and must precede the current proof. Exact chain prev/hash/signature and envelopeHash bindings remain mandatory. Public bodies expose only IDs, state, revisions and the SHA-256 canonical-JSON purpose commitment, not plaintext purpose. Purpose hashes are commitments, not a claim of resistance to guessing short text. Reject unknown fields/types/states and malformed references before replay; constructors copy only named fields. Record payloads are exactly `{type:'project.content',typeVersion:1,body:{purpose}}` for create/purpose and `{type:'project.marker',typeVersion:1,body:{}}` for the other actions, within the existing 1,048,576-byte JSON cap. Ciphertext cannot choose project, member, state, placement, actor or grants. Public replay uses unavailable purpose text; keyed reads validate the exact payload and purpose commitment and fail before returning a partial project view. Existing control.labels and artifact payload restrictions stay unchanged.
3. **Creation and participation:** project creation is an ordinary content write under D5, allowed to any current read-write person or effective read-write agent, never from guide status alone and never during pending rotation. Initial participation is empty, including for the creator: creating a grouping is not permission to enroll another person. A person of either role explicitly signs join/leave for themselves only; repeated join of an active pair or leave of an inactive pair conflicts, and a stale pair predecessor conflicts. No invitations, approval, participant cap, minimum participant count or guide-only administration are invented. Agents cannot sign join/leave for themselves or their adding person; CLI/MCP must report participation as inherited and tell the person how to change theirs. This distinguishes provenance from participation and avoids a writable agent changing its person's participation. Empty projects remain valid and joinable.
4. **Agents follow, without stored agent joins:** authoritative participation stores only person joins/leaves. Production Bend derives effective project participants from currently live journey people and their current participation, and from live agents whose adding person is currently live and participates. Adding an agent after a person's join includes it immediately; a person leaving/removal/expiry immediately excludes that person and all their agents; agent removal/expiry excludes that agent. Person removal deactivates their recorded pairs in Bend replay, so re-admission cannot revive previous participation; a fresh explicit join is required. Rejoining includes current agents again. Role changes do not change participation. D34's original read-only/read-write limit continues to govern ordinary content writes; D17 is a metadata exception for participating people and their participating agents of either effective role, not a new agent-specific permission rule. An agent may edit purpose/state within its person's participation, but cannot invent an independent join or exceed inherited ordinary content access. Agent links inherit participation for display but remain unable to submit any action (D28).
5. **Metadata authority and conflicts:** any effective project participant may change purpose/state even when read-only; nonparticipants, including a guide who has not joined, cannot. Membership changes do not increment the purpose/state revision, and metadata changes do not increment participation revisions, so unrelated joins do not cause false edit conflicts. Purpose/state changes both require the current shared project revision; concurrent edits fail with 409 conflict and a refresh instruction rather than silently winning. Membership/access is checked at signed entry time in replay and against current verified state/time at server commit. Missing/removed/expired actors or adding people have no metadata authority. Current identity/version/epoch and signature checks still apply during rotation; metadata exceptions do not authorize key rotation or any ordinary content write.
6. **State and archive:** creation always starts at `getting-started`. State strings are exactly `getting-started`, `active`, `looking-for-others`, `archived`, with human labels using spaces. Any effective project participant may choose any different state, including skipping, going back, archiving and reopening to any of the three nonarchived states; setting the same state conflicts. Every accepted change records its signer, timestamp, old/new state and revision from verified history. There is no inferred state, automatic reopening or restoration of a guessed earlier state. Archive is a readable state label, not an extra freeze/access rule: joining/leaving and metadata edits remain allowed, and D5 continues to govern artifacts/comments/placement in archived projects. Archived projects and their artifact references remain visible in project navigation/filtering; hide neither solely due to archive. The UI labels archived status and offers explicit reopening/state selection. This preserves D19 without inventing a restriction absent from D17/D18.
7. **Artifact-copy placement:** `artifact.project` changes a single nullable project pointer on a stable, undeleted artifact in its containing journey. A current read-write member (person or effective agent) may assign, move or clear it regardless of project participation or authorship; projects are not access boundaries. D17 grants no placement permission. Validate the signed original author and actual signer, current placement predecessor and existing same-journey project; arrays, duplicate/multiple targets, nonexistent/foreign projects, deleted artifacts and stale/no-op changes fail. Content versions/comments retain their own IDs, predecessors, authors and attachment references; placement does not create a content version, copy bytes, change author, loosen blob rules or rotate keys. Existing and newly created artifacts start unassigned. Preserve Stage 1 artifact.create/version shapes; assignment is an explicit subsequent signed action, not an optional unsigned project field or an atomic grouped-create promise. The browser/CLI/MCP offer assignment after successful creation and for existing artifacts. Later Stage 6 copies will have independent placement in their containing journey; this stage builds no cross-journey copy flow.
8. **Filtering and reads:** introduce a narrow portable core selector for project placement, not the Stage 7 general read refactor. Omitted selector/`main` means only undeleted unassigned artifacts; explicit project ID includes only that project's artifacts; `all` explicitly includes unassigned plus every project's artifacts, including archived projects. Compose with existing type/tag/text filters by intersection, never fall back to all for an unknown ID or malformed selector. Selector IDs are syntactically validated in TypeScript; project existence, placement validity and lifecycle/deletion decisions use Bend on verified state. Project placement is list organization, not read permission: direct show, versions, comments, attachment download and encrypted export remain available to the journey's authorized readers, including nonparticipants and archived project readers. Counts accompanying a filtered list describe that list; project navigation supplies separate clearly labelled counts. Preserve recovery exclusion. Do not silently hide project artifacts from export or deletion/reference accounting.
9. **Interfaces and links:** browser project list/detail/history, create, own join/leave, purpose/state/archive/reopen and artifact assignment/move/clear use the signed helpers and Bend-derived availability. Default journey artifact list is main; expose project and all filters, preserve chosen filter across reload/navigation, and show inherited agents without separate join controls. Add CLI `project list|show|create|join|leave|purpose|state` and `artifact project <artifact-id> <project-id|none>` plus corresponding stdio MCP `project_list`, `project_show`, `project_create`, `project_join`, `project_leave`, `project_purpose`, `project_state`, `artifact_project`; agent join/leave return the inherited-participation explanation without sending controls. Existing artifact list/search gain explicit project/all selectors; default main. Metadata/placement edits require a supplied observed predecessor in CLI/MCP; browser uses its loaded revision and reports conflicts. Agent links extend only the existing read-only paged `/a/:secret` overview: omit `project` for main, `?project=<ULID>` for one project or `?project=all` for all. Show project purpose/state/effective participants and each artifact's nullable project ID, with project data paged as rows rather than unbounded headers. Keep all response pages at or below existing PAGE_LIMIT, preserving Unicode and query selector in next URLs; large purpose/roster rows use continuation markers. Unknown project returns 404, malformed selector 400; invalid page never changes the selector. No link write/download/search/show/comments routes, anonymous joins or drops. Keep live-link decryption explicit, no-store/no logging/caching, expiry/revocation behavior, existing attachment notice and recovery exclusion. Narrow selector consistency tests across interfaces do not claim full D27 parity, which remains Stage 7.
10. **Versions and archives:** use core/client/interface version `0.1.6` with `project-v1` in addition to `control-proof-v1` and `artifact-v1`; transport header `X-Project-Format`, authenticated protocol response `projectFormat`. New journeys require 0.1.6 and all three capabilities. Existing signed 0.1.4/0.1.5 regression journeys are not purged or silently upgraded: a person guide of either role must first sign client.minVersion to at least 0.1.6 before any project action. Project actions below that boundary fail; the minimum never decreases. At a project minimum all journey reads and all writes, including artifact/blob/personal controls, require the three capabilities; the authenticated protocol negotiation route still returns only format/version metadata so an old caller gets an actionable update message. A minimum-raising request must itself satisfy the resulting minimum/capabilities. Unsupported, absent/malformed or too-old versions and unknown actions fail closed before partial content; claims do not replace signatures/access. Live agent links use the running server's version/capabilities and fail with its existing update-server message when unsupported. Update core/client manifest versions and dependencies/lock (leave private server/web package versions and rules package version as they are); 0.1.7 becomes the unsupported future signed-minimum fixture, with explicit 0.1.3-or-older rejection still covered. Preserve artifact-v1/version-1 encrypted archive container and existing APIs: retain exact new controls/payloads and rebuild projects, revisions, effective participation and placements by verified replay, never accept a caller-supplied project index. Make archive named-field projection handle all controlDefinitions, not only legacy logDefinitions. Old readers must reject the signed 0.1.6 minimum/unknown controls rather than omit projects. Test an actual encrypted round trip with project history and live blob bytes, plus project payload/proof/reference tampering. No browser import flow, archive migration or new rollback guarantee.

## Questions for Dan

None. The Stage 2 product rules are settled in the cited decisions and ontology. Creation authority, initial participation/state, record format, archive behavior, conflict handling, selectors and version boundaries above are technical choices for lead review, not unanswered product questions.

## Current code observations

Read docs/ontology.md, decision 0001, docs/journey-protocol.md, the Stage 1 draft/promoted spec, and the tracked source/tests/configuration in packages/core, packages/rules, packages/server, packages/web and packages/client, plus scripts/check-bend-boundary.mjs, in full against clean main 9becdf6. These are source observations, not passing Stage 2 evidence.

- ControlProof and controlDefinitions are the active authority format. Core verification verifies signatures/chain before Bend replay; artifacts have strict separate payload decoders. Legacy logDefinitions remain separate and must not be repurposed into an independently authoritative project log.
- packages/rules/{rules.bend,rules.d.mts,LAWS.bend,PROOF.bend} implement Stage 0 inherited access/control replay and Stage 1 artifact/blob decisions. scripts/check-bend-boundary.mjs scans all four TypeScript consumer source trees with AST checks and required call checks, but has no project decision family yet. rules.mjs is ignored generated output; build first, use scripts/bend.mjs with HOME unset, and run bend guide before writing Bend.
- packages/server/src/enclave.ts serializes verified authority effects, atomically stores signed proof/state/reference changes and gates current reads/writes using Bend. Its minimum-dependent capability selection presently knows Stage 0/Stage 1 only. Subject/CreateJourney/protocol/upgrade responses and browser/client request headers need a project format field copied by name. Project actions must use the existing signed /log path, not ordinary /records or plain accessChanges.
- packages/core/src/transfer.ts's artifact archive keeps the exact signed chain/live blob bytes, but archiveProof uses legacy logDefinitions for nonartifact bodies. Additive project controls need an explicit strict projection there; no index supplied by a caller is authoritative.
- Browser/client artifact lists currently filter type/text/tags but have no project placement. Their direct detail/history/file/export paths must not be treated as restricted to project participants. Stage 1 artifact payloads are strict: adding project as an unchecked payload extra would fail or bypass signed placement.
- packages/server/src/agentLink.ts currently returns paged artifact/legacy text and people, with no project selector. Link requests construct version/capability claims internally and must be updated too. Project purpose/participant collections must enter pagination, not a potentially oversized shared header.
- CLIENT_VERSION/ARTIFACT_CLIENT_VERSION and public core/client manifests are currently 0.1.5, with control-proof-v1/artifact-v1 capabilities. Existing 0.1.6 future-minimum fixtures must become 0.1.7 where they mean unsupported. The ontology appendix's old removal/role/text/version gaps are stale relative to main; current code wins, and none requires restoring old paths. Protocol account-key/recovery guidance differs from current code and stays separate backlog.
- Root build orders rules before consumers; core tests have Node/workerd/browser runners, server tests use workerd/local R2, and browser e2e/client local-server tests share port 18787. Run local-server gates serially with ignored test fixtures and guaranteed cleanup. No new runtime/dependency is needed for projects.

## Criterion homes and proof contract

Every Stage 2 focused test and negative-control runner below is a planned deliverable, not an existing test or observed pass. Each criterion has one command evidence object; expect exit 0, its printed marker and real assertions. Run from a clean committed repository root with dependencies installed, as `env -i PATH="$PATH" sh -c '<run>'`; HOME and live services are not prerequisites. Each command checks clean status, records `git diff --binary HEAD -- .` before/after and demands equality plus a clean final status. Evidence may generate only ignored build/cache/scratch outputs; it cannot install packages, change tracked manifests/locks/sources or hide diffs. The negative runner uses disposable ignored copies, verifies baseline success, names every mutation and expected test, and demands assertion/proof failure, not syntax/setup/missing-module failure. Missing tests, surviving mutants and failed setup must make the runner fail. Tests supply prohibited input and prove it neither persists nor survives output; a marker alone proves nothing.

| Criterion | Observable result | Owning node | Evidence | Why here |
| --- | --- | --- | --- | --- |
| project-contract | Strict signed contracts, participation/placement replay, selectors, archives and version boundary | project-contract | command | Core owns portable contracts and verified adapters |
| project-laws | Production Bend project/participation/metadata/placement/version laws and proofs | project-contract | command | Rules and adapters must ship together |
| project-authority | Serialized current server authority, races, format gates and paged read-only links | project-authority | command | Server owns durable effects and live-link decryption |
| browser-projects | Reloaded person workflows and list/detail/read-authority distinction | browser-projects | command | Browser owns person participation controls |
| client-projects | Real CLI/MCP project and artifact-selector workflows under inherited access | client-projects | command | Agent surfaces own signed metadata and clear inherited participation |
| stage2-negative-controls | Executed guard-removal probes and extended AST Bend boundary | integration | command | Assembled code owns cross-boundary proof |
| stage2-regression | All package/runtime regressions, proof modes, builds, archives and link selectors | integration | command | Integrated tree owns final regressions |

## Scope overlap review

Five worker-sized nodes. project-contract establishes rules, schemas, archive projection, 0.1.6/header/fixture alignment and the narrow shared selector first. project-authority then owns routes, durable effects and the existing agent-link overview, including any transport rule additions. browser-projects and client-projects depend on project-authority and can edit in parallel, but their server-backed evidence cannot share port 18787. integration follows both. Core/rules/protocol, version manifests/lock, journey request adapters and fixture files are intentional serialized shared paths, not independent parallel ownership; concentration advisories for them are accepted for that reason. Neither interface node edits manifests or the other interface's scope. No node widens touches without lead review. All nodes use refs to this draft (Decisions taken, boundaries and proof contract), docs/ontology.md (Stage 2/access/participation), decision 0001 (amendment precedence) and docs/journey-protocol.md (existing signed formats).

## Worker boundaries

### project-contract

Depends on: none.

Touches: ["packages/rules", "packages/core/src/projects.ts", "packages/core/src/controlProof.ts", "packages/core/src/log.ts", "packages/core/src/rules.ts", "packages/core/src/types.ts", "packages/core/src/transfer.ts", "packages/core/src/index.ts", "packages/core/src/versions.ts", "packages/core/package.json", "packages/server/package.json", "packages/web/package.json", "packages/client/package.json", "package-lock.json", "packages/core/test/stage2-projects.test.ts", "packages/core/test/stage2-archive.test.ts", "packages/core/test/stage0-fixture.ts", "packages/server/test/stage0-fixtures.ts", "packages/server/test/stage1-fixtures.ts", "packages/client/test/local-server.ts", "packages/web/e2e/person.ts", "packages/web/e2e/agent.ts", "packages/web/e2e/stage1-fixtures.ts", "packages/web/src/journey.ts", "packages/web/src/artifacts.ts", "packages/client/src/journey.ts", "packages/client/src/artifacts.ts", "packages/server/src/types.ts", "packages/server/src/index.ts", "docs/journey-protocol.md"]

Define strict project actions/payloads, revisions and placement history in a new core module; extend ControlProof dispatch, state and named-field adapters for verified production Bend replay. Keep legacy logDefinitions unchanged and encrypted controls/content nonauthoritative. Implement person-only join/leave, derived live agent participation, removal invalidation, separate D17 metadata and D5 content decisions, fixed creation state, all specified state transitions, metadata/placement conflicts, same-journey single placement and narrow shared selectors. Add Bend laws/proofs for actual production functions, including no read-scope elevation, no independent agent participation, no participation resurrection, archive readability, stable content identity/references and version readiness. Extend archive projection and encrypted round-trip verification. Own initial version/dependency/lock alignment and named capability headers/types/fixture plumbing needed for downstream evidence; no server authorization/effects or UI feature implementation. Retain old-history regression fixtures and fail closed for unsupported actions. Run focused portable tests in Node, workerd and browser plus archive tests in Node; no unrelated crypto or general read refactor.

### project-authority

Depends on: project-contract.

Touches: ["packages/rules", "packages/server/src/enclave.ts", "packages/server/src/index.ts", "packages/server/src/types.ts", "packages/server/src/agentLink.ts", "packages/server/test/stage2-projects.test.ts", "packages/server/test/stage2-link.test.ts", "packages/server/test/stage2-fixtures.ts", "packages/server/README.md", "docs/journey-protocol.md"]

Use existing signed /log route and serialized Durable Object authority, not a parallel project authority table. Recheck current actor identity/access/participation, predecessor, version/capabilities, current epoch and pending rotation through Bend at commit, including a control queued before leave/removal/expiry/downgrade or another metadata/placement change. A role downgrade removes ordinary writes, not D17 participant metadata authority; a leave/removal does remove metadata authority. Commit proof, project/participation/placement projection and chain head in one transaction; rejected requests change nothing, exact committed proof retries are idempotent, and changed stale proofs conflict. Extend Bend transport rules/laws/proofs if needed; no TypeScript participation or role decisions. Gate protocol/upgrade/create/list/access/log/records/wraps/blob/export/control paths consistently; negotiation is content-free. Implement the specified existing-link selectors, project rows/continuations and selector-preserving pagination using verified replay/shared selector, current link access and PAGE_LIMIT. Test real local workerd/R2 storage, fresh-object persisted replay, current-access races, no caller extras/plain purpose in storage, link default main/project/all, large Unicode purpose/rosters, malformed/foreign selectors, update/expiry/revocation, nonparticipant reads and no link mutations. Document routes/headers; no new private-artifact/public or Stage 7 service.

### browser-projects

Depends on: project-authority.

Touches: ["packages/web/src/projects.ts", "packages/web/src/main.ts", "packages/web/src/journey.ts", "packages/web/src/artifacts.ts", "packages/web/src/style.css", "packages/web/e2e/stage2-projects.spec.ts", "packages/web/e2e/stage2-fixtures.ts", "packages/web/README.md"]

Implement browser project list/detail/history, creation, self join/leave, purpose/state/archive/reopen and explicit saved-artifact assignment/move/clear. Show empty/archived projects, derived people/agents and meaningful conflicts. Use loaded revisions and signed helpers/Bend availability; readonly participants can edit project metadata but cannot write/place artifacts, comments or files. Default artifact list is main, with preserved project/all selector combined with existing search/type/tag filters; project detail/read/download/export is not limited to participants. Reload stored history after every asserted mutation, including a new agent after join, person leave/rejoin/removal and reopening. Escape hostile purpose text and do not execute markup or fetch resources. Prove header/footer and Stage 0/1 controls/viewers unchanged, update/error behavior without partial views, and no ordinary content writes during rotation. No manifests or new runtime dependency.

### client-projects

Depends on: project-authority.

Touches: ["packages/client/src/projects.ts", "packages/client/src/journey.ts", "packages/client/src/artifacts.ts", "packages/client/src/cli.ts", "packages/client/src/mcp.ts", "packages/client/src/index.ts", "packages/client/test/stage2-projects.integration.test.ts", "packages/client/test/stage2-fixtures.ts", "packages/client/README.md"]

Implement the exact CLI/MCP surfaces and narrow shared selectors from Decisions taken, maintaining approval-first connection, explicit inputs/local files and current authority. Project create is content-write-only; purpose/state is inherited-participation metadata authority; placement stays content-write-only. Agent join/leave emits an explanation without posting any action. Expose observed revisions/history/effective participants and require an observed predecessor for metadata/placement changes; stale writes conflict and need reread. Real CLI subprocess and stdio MCP tests against local workerd must exercise read-only participant agent metadata, nonparticipant denial, new-agent following, owner leave/removal/expiry, original read-only limit/downgrade, archived reads/reopen, selectors, ordinary artifact/blob/comment refusal, update/capability/unknown-action failures and unchanged credentials/approval. Use test state/keychain only; no manifests or Stage 7 general refactor.

### integration

Depends on: browser-projects, client-projects.

Touches: ["scripts/check-bend-boundary.mjs", "scripts/check-stage2-negative-controls.mjs", "packages/core/src/versions.ts", "packages/core/package.json", "packages/server/package.json", "packages/web/package.json", "packages/client/package.json", "package-lock.json", "packages/core/test", "packages/server/test", "packages/web/e2e", "packages/web/src/stage0-versions.test.ts", "packages/client/test", "packages/core/README.md", "packages/server/README.md", "packages/web/README.md", "packages/client/README.md", "docs/journey-protocol.md"]

Check/complete 0.1.6 core/client/dependency/lock and all interface/header/fixture boundaries; unsupported future minimum is 0.1.7, with explicit old/missing-capability cases retained. Preserve existing regression histories without migration. Extend the AST-based boundary check for project participation/inheritance, metadata authority, state transitions, placement/reference and version decisions, with required real Bend calls and negative fixtures detecting both equality/membership branches and independently derived participant filtering. Exempt only exact named-field format adapters, never whole functions/consumers. Own the disposable mutation runner and cross-interface selector/archive integration cases, including long link pagination and archived artifact downloads/exports. Execute full existing/new suites/builds/proofs/boundary checks and Stage 2 negative controls; preserve Stage 0/1 laws. Mutation cases must weaken: self-only participation; following/invalidation; D17 participant checks and its separation from content; creation authority/initial state; predecessor/atomicity; single same-journey placement/deleted reference; main filtering; versions/capabilities/unknown controls; payload/hash/extra-field boundary; link read-only/selector/pagination. Representative production Bend mutations must fail both focused assertions and PROOF.bend. Structural duplicate TypeScript rules must fail --rules. Report each guard, case, exit and assertion/proof failure. No unrelated backlog or live services.

## Evidence commands

These commands become node-owned `kind: command` evidence on promotion/decomposition. Each has `expect.exit: 0` and `expect.output_includes` equal to its final printed marker. Focused commands use `timeout_ms: 600000`; integration commands use `timeout_ms: 3600000`. Their tests/runners must be delivered before these commands can pass. Run gates serially if they start port 18787; stop every server on success/failure.

### project-contract command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run test -w @ai-wayfinding/core -- test/stage2-projects.test.ts test/stage2-archive.test.ts
npm run test:workers -w @ai-wayfinding/core -- test/stage2-projects.test.ts
npm run test:browser -w @ai-wayfinding/core -- test/stage2-projects.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 2 project-contract assertions passed\n"
'
```

### project-laws command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
(cd packages/rules
  proof=$(node ../../scripts/bend.mjs PROOF.bend)
  printf "%s\n" "$proof"
  case "$proof" in *"ALL PROOFS CHECK"*) ;; *) exit 1 ;; esac
  verdict=$(node ../../scripts/bend.mjs PROOF.bend --verdict)
  printf "%s\n" "$verdict"
  case "$verdict" in *"ALL PROOFS CHECK"*) ;; *) exit 1 ;; esac
)
npm run test -w @ai-wayfinding/core -- test/stage2-projects.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 2 project-laws assertions passed\n"
'
```

### project-authority command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
(cd packages/rules
  proof=$(node ../../scripts/bend.mjs PROOF.bend)
  printf "%s\n" "$proof"
  case "$proof" in *"ALL PROOFS CHECK"*) ;; *) exit 1 ;; esac
  verdict=$(node ../../scripts/bend.mjs PROOF.bend --verdict)
  printf "%s\n" "$verdict"
  case "$verdict" in *"ALL PROOFS CHECK"*) ;; *) exit 1 ;; esac
)
npm run test -w @ai-wayfinding/server -- test/stage2-projects.test.ts test/stage2-link.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 2 project-authority assertions passed\n"
'
```

### browser-projects command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run test:e2e -w @ai-wayfinding/web -- e2e/stage2-projects.spec.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 2 browser-projects assertions passed\n"
'
```

### client-projects command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run build -w @ai-wayfinding/client
npm run test -w @ai-wayfinding/client -- test/stage2-projects.integration.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 2 client-projects assertions passed\n"
'
```

### stage2-negative-controls command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
node scripts/check-stage2-negative-controls.mjs
node scripts/check-bend-boundary.mjs --rules
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 2 stage2-negative-controls assertions passed\n"
'
```

### stage2-regression command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
(cd packages/rules
  proof=$(node ../../scripts/bend.mjs PROOF.bend)
  printf "%s\n" "$proof"
  case "$proof" in *"ALL PROOFS CHECK"*) ;; *) exit 1 ;; esac
  verdict=$(node ../../scripts/bend.mjs PROOF.bend --verdict)
  printf "%s\n" "$verdict"
  case "$verdict" in *"ALL PROOFS CHECK"*) ;; *) exit 1 ;; esac
)
node scripts/check-bend-boundary.mjs --rules
npm run typecheck -w @ai-wayfinding/core
npm run build -w @ai-wayfinding/core
npm run typecheck -w @ai-wayfinding/server
npm run typecheck -w @ai-wayfinding/web
npm run typecheck -w @ai-wayfinding/client
npm run build
node scripts/check-bend-boundary.mjs --build
node scripts/check-bend-boundary.mjs --guidance
npm run test -w @ai-wayfinding/core
npm run test:workers -w @ai-wayfinding/core
npm run test:browser -w @ai-wayfinding/core
npm run test -w @ai-wayfinding/server
npm run test -w @ai-wayfinding/web
npm run test:e2e -w @ai-wayfinding/web
npm run test -w @ai-wayfinding/client
npm run test:integration -w @ai-wayfinding/client
npm run test -w @ai-wayfinding/core -- test/stage2-projects.test.ts test/stage2-archive.test.ts
npm run test:workers -w @ai-wayfinding/core -- test/stage2-projects.test.ts
npm run test:browser -w @ai-wayfinding/core -- test/stage2-projects.test.ts
npm run test -w @ai-wayfinding/server -- test/stage2-projects.test.ts test/stage2-link.test.ts
npm run test:e2e -w @ai-wayfinding/web -- e2e/stage2-projects.spec.ts
npm run test -w @ai-wayfinding/client -- test/stage2-projects.integration.test.ts
node scripts/check-stage2-negative-controls.mjs
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 2 stage2-regression assertions passed\n"
'
```

## Acceptance criteria <!-- work:criteria -->
- project-contract: When the portable Stage 2 contract suites run, strict signed project/payload formats, getting-started creation, person-only participation with live agents following and removal invalidation, separate D17 metadata and D5 content authority, recorded state/archive/reopening, metadata/participation/placement predecessor conflicts, zero-or-one same-journey project per undeleted artifact, main/project/all selector intersection, stable artifact/version/author/blob identity, encrypted archive replay and 0.1.6/project-v1 boundaries pass; forged, stale, expired, foreign, deleted, unsupported, unexpected-field or ciphertext-authority inputs fail without partial views or caller-controlled indexes.
- project-laws: When production Bend project rules compile and PROOF.bend runs normally and with --verdict through scripts/bend.mjs, both print ALL PROOFS CHECK for self-only participation, derived live agent following/removal, D17 participant metadata access without ordinary content elevation, content-only creation/placement, initial and recorded state transitions with archive readability/reopening, current predecessor and single same-journey undeleted placement, and project version readiness while preserving Stage 0/1 laws; TypeScript consumers use these production functions rather than duplicate decisions.
- project-authority: When local workerd/R2 Stage 2 server/link tests run, signed project actions atomically persist only under current verified identity, participation/content authority, epoch, revision and version/capabilities; downgrade preserves D17 metadata but blocks ordinary writes, leave/removal/expiry blocks metadata, stale/foreign/extra-field actions leave storage unchanged and exact-proof retries are idempotent; content-free negotiation and update errors precede content, nonparticipants can read archived project artifacts, and read-only link main/project/all pages include bounded verified project data with selector-preserving Unicode pagination, no recovery/plaintext stored purposes, no mutation/download routes and unchanged expiry/revocation.
- browser-projects: When browser end-to-end tests reload stored Stage 2 history, people create and explicitly join/leave projects, agents follow current participation, read-only participants edit purpose/state/archive/reopen without gaining ordinary artifact/comment/blob/placement writes, nonparticipants cannot edit metadata but can read project artifacts, and artifact assignment/move/clear plus main/project/all filters, recorded history, stale conflicts, pending-rotation distinctions and update errors work; hostile purpose is inert, stored results survive reload, and header/footer plus Stage 0/1 controls/viewers/export remain intact.
- client-projects: When real CLI subprocess and stdio MCP tests run against local workerd, approved agents list/show/create projects, use inherited-participation metadata authority, report join/leave as inherited without posting controls, assign/move/clear artifacts only under current content authority and observed predecessors, and use main/project/all selectors consistently; archived reads/reopening, new-agent following, owner leave/removal/expiry, read-only limits/downgrade, stale conflicts and unsupported versions/capabilities/actions behave as specified without ordinary-write elevation, partial content or credential/approval regressions.
- stage2-negative-controls: When the disposable Stage 2 negative-control runner and extended AST Bend boundary gate run, every named weakened participation/inheritance/invalidation, D17/content separation, creation/state, predecessor/atomicity, placement/reference, filtering, version/capability/unknown-control, payload/extra-field and link guard reaches its expected assertion failure; representative Bend decision mutants also fail proofs, duplicate TypeScript decisions fail --rules, and missing tests, setup failures or surviving mutants fail the runner while production tracked files remain unchanged.
- stage2-regression: When the assembled Stage 2 tree runs full existing Stage 0/1 and new Stage 2 gates, all package typechecks/builds, core Node/workerd/browser tests, server workerd/R2 tests, web unit/end-to-end tests, client unit/integration tests, both Bend proof modes, all boundary modes, encrypted project/archive/blob round trips, selector/link pagination integration and negative controls pass serially where ports overlap; 0.1.6/project-v1 alignment and 0.1.7 unsupported-future fixtures are consistent, previous histories are not purged/migrated, and evidence changes no tracked files or requires HOME, live services or deployment.
