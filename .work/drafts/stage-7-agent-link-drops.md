# Stage 7: agent-link parity and drops

## Summary <!-- work:summary -->
Deliver shared core overview/list/filter/search/show/comments reads used by the browser, CLI/MCP and live read-only agent links. Prove client/link parity on one journey and browser use of the same selectors. Deliver member-created delivery drops and agent-link proposals, anonymous browser/agent delivery, exact creator approval and separately authorized inclusion. Enforce single use, 24-hour expiry, bounded uploads, proposal-metadata deletion and non-sensitive status. Keep private artifacts absent from links, including existence, whichever Stage 3 storage option is chosen. This draft records a plan, not implementation approval or passing evidence. Q1–Q9 are resolved below from the operator decisions and the current direction: applets retain their Stage 5 powers, and agents have exactly their member’s access, without person-only drop rules.

## Why <!-- work:rationale -->
Ontology section 9 Stage 7, sections 5–7 access/boundary rows and section 10, and decision 0001 D5, D9–D13, D18–D19, D26–D31 and D33–D44 define the result. D42 replaces D29's signed-in delivery-only flow: delivery needs no sign-in and grants no journey access; the creator always approves, and approval grants no content-write permission. D31/D36 exclude all private artifacts from agent links; D44 interview-subject reads do not override this exclusion. D27 requires shared reads, not link write parity. Main at 889b218 is the inspected baseline; it contains Stage 0/1, not Stage 2–7 implementations. Earlier-stage readiness remains a prerequisite. The recorded operator choices govern this draft; align the implementation protocol with them rather than treating superseded recommendations as permission gates.

All access, audience, participation, lifecycle, permission, replay and inclusion decisions belong in production Bend functions in packages/rules, with LAWS.bend and PROOF.bend covering those actual functions. TypeScript validates exact formats, signatures, ciphertext commitments, identity/journey/epoch bindings and byte counts; copies named fields; encrypts; transports; stores; and projects verified Bend results. Extend scripts/check-bend-boundary.mjs without weakening earlier checks. Signed ControlProof remains the only journey authority. Delivery receipts or encrypted text cannot become controls or grants. Ephemeral drop transitions have authenticated/signature-bound inputs and Bend decisions, not an independently trusted SQL permission table.

A hostile or careless caller must not reveal a private artifact's existence through overview, search matches/snippets, counts, pagination, direct IDs, comments, versions, relationships, attachment references, errors or logs; exceed D34 inherited access; use project membership as a new read boundary; turn a link/drop into ordinary writes, membership, key retrieval or private-vault access; replace the creator's approval with a writer's consent; write after downgrade/removal/expiry/rotation; substitute content after approval; forge suggested-by/author/writer attribution; race a second delivery/inclusion; retain proposal text after completion/expiry; execute hostile text during review; fetch a submitted URL during delivery/review; or spread caller extras into persistence/output. Existing encrypted histories and downloaded copies cannot be remotely erased or recalled. These delivery/review limits are not new restrictions on an included applet: its explicit Stage 5 runtime retains the viewer’s authorized powers. A caller must not gain extra access by being an agent, but an otherwise authorized agent must not be refused solely because it is not a person.

### Earlier-stage prerequisites
- Stage 0 supplies verified current roles, guide separation, agent inheritance, removal/expiry, rotation and signed minimums. Stage 1 supplies strict artifacts, files, signed attribution, comments, deletion and blob reference rules. Reuse these, rather than restoring the appendix's old independent-agent scopes.
- Stage 2 (being built; client 0.1.6) supplies projects, inherited participation, zero-or-one placement and main/project/all filtering. Stage 7 replaces its narrow selector adapter with shared reads without changing its access or archive behavior.
- Stage 3 (planned client 0.1.7) is on hold pending Dan's choice: device-only private storage or one padded encrypted vault per member on the server. Stage 7 depends on the chosen Stage 3 audience adapter and exclusion tests, not either storage implementation. Device-only records never enter link assembly; padded vaults, private indexes, identifiers and counts are never loaded/unwrapped by link handling. Link results must be identical with or without hidden private material under either option. Do not build a fallback journey-key private store or disclose vault inventory.
- Stage 4 supplies rounds, interview labels/subject access and confirmed contributions. Shared reads preserve these audiences; drops cannot mark interviews, contribute findings or bypass member confirmation merely by claiming a type/relationship.
- Stage 5 supplies HTML/applet sandboxing and viewer data access. Shared reads expose inert source/metadata within the viewer’s access; they do not execute content on the server or use author credentials. Explicit applet viewing uses the existing Stage 5 runtime and its network/data powers, not an additional Stage 7 sandbox. An applet viewed through a link has only the link’s non-private audience.
- Stage 6 supplies public journeys, visibility/listing/joining, copy identity/provenance and D43 attribution. Shared reads support both public and private journeys; private copies remain private in either, and public output never names a private source journey. Drops are not a joining-policy shortcut.
- These are external stage prerequisites, not extra nodes in this draft. Ship Stage 7 after the preceding stages. If one is absent, report the blocked dependency rather than stub its safety boundary. Recheck their final formats and gates before implementation; their drafts are not code or evidence.

Out of scope: deciding Stage 3 storage; rebuilding earlier-stage features; link direct artifact/comment/edit writes; new recipient-sharing grants for private artifacts; account deletion, key-persistence/recovery discrepancies, historical agent-wrap hardening, rollback checkpoints or cryptographic certification. Preserve approval-first connection, saved credentials, existing link creation/passkey renewal/revocation, header/footer, attachment limits and safe viewers. No deployment, provisioning, npm publication, real Keychain/journey access or remote action is evidence.

## Decisions taken

These technical choices incorporate the settled Q1–Q9 decisions recorded below. The current direction that agents get exactly their member’s access supersedes Q3’s former browser/person-only inclusion recommendation. No node ids or dependencies change: the existing client node already owns signed drop operations.

1. **One verified read model:** add portable core reads in `packages/core/src/reads.ts`. Its input is verified signed state, decoded/validated content and an explicit viewer context produced by the earlier-stage audience adapters. The server/client/browser loaders still own crypto and transport. Raw caller-supplied indexes, roles and viewer claims are not authoritative. Core exposes `overview`, `list`, `filter`, `search`, `show` and `comments`; `show` includes available versions with immutable author separate from each actual writer. Move duplicate artifactText, grouping, attribution and filtering into this model. Keep compatibility wrappers for existing client/browser methods so this is not an unrelated API rewrite. Recover historical writer kinds from verified history, not a guessed person default. Deleted/recovery/internal records never enter ordinary reads. Unknown required actions or malformed keyed payloads fail before partial output. Do not make optional device-private data a prerequisite for non-private reads.
2. **Audience before selection:** production Bend decides visible records/references for the verified viewer, using Stage 3/4/6 rules. For a link viewer, explicitly exclude every private artifact, including its own adding person's private artifacts and subject-readable interviews. Apply exclusion before indexes, search, counts, cursors or relationship projection. Then apply the Stage 2 main/project/all selector and type/tag/text filters by intersection. Direct show/comments/versions ignore list placement but still require the audience; archived projects are readable, nonparticipants retain journey reads. Missing, foreign, deleted and hidden IDs share the same not-found shape/status. Related IDs are omitted when their targets are outside the audience; no hidden-target placeholders. Project/round counts and overview totals describe visible data only. Public attribution follows Stage 6, including `a member` and private-origin suppression. Browser and authenticated client may return additional author/subject-private content if their earlier-stage access permits it; parity compares their link-visible subset, not a demand to expose those records through links.
3. **Deterministic selection and paging:** use exact case-preserving type/tag equality; search uses Unicode-normalized NFC plus locale-independent lowercase substring matching over title, tags and portable artifact text, including supplied URL/summary/notes and visible attachment filenames/package paths from the current head, but not comment text, historic versions, binary bytes or downloaded remote content. Search never fetches attachments/URLs or builds a persistent server plaintext index. Comment search is not introduced. Apply this Q9 field set in core and every interface; test field-specific matches and NFC/case normalization without indexing hidden names. Return a declared stable ID sort, and comments by proof sequence then ID; preserve full text/tags rather than today's truncation as an authoritative result. List filters default to main; empty search matches that selected list. Reject malformed/duplicate/unknown query fields with 400 and unknown projects with 404, without widening scope. Pure core pagination accounts for UTF-8 JSON bytes, escaped strings, complete headers and widest continuation markers within PAGE_LIMIT=12,000. Long strings use Unicode-safe numbered continuations. A cursor carries query and verified shared-history revision; stale revision returns 409 refresh, not mixed snapshots or silently dropped rows. Link cursors must not encode private inventory/revisions. No cursor bypasses fresh live-access checks.
4. **Link read routes:** preserve `GET /a/:secret` as overview and add `GET /a/:secret/list`, `/search?q=...`, `/show/:artifact`, `/comments/:artifact`. Use `project`, `type`, `tag` and paging on list/search; preserve selectors in every next URL. Document route/query mappings to the same core reads used by CLI/MCP/web. Every route resolves the secret hash, checks current verified agent/adding-person access and expiry, verifies history and decrypts only link-available content in memory. Keep 410 for expired live rows, 404 for ended/unknown links and 502 with the existing update-server guidance for unsupported server readers. Preserve no-store/no-transform, noindex, no-referrer and nosniff; neither errors nor logs contain secrets, queries, decrypted bodies or private counts. Retain current 60-per-hour link read rate limit, shared across read routes; return 429/Retry-After. Core parity covers textual content and attachment metadata. Q7 retains member-interface downloads and an explicit link notice; no binary download route is added and metadata parity is not byte parity. No link route submits journey controls, reserves sequences or gets raw keys.
5. **Drop contract and secret separation:** add core `drops.ts` with exact named-field validators and Web Crypto helpers, plus compiled Bend lifecycle adapters. Use a fresh journey-local ULID `drop`, immutable creator principal, optional verified suggesting-agent principal, creation/expiry timestamps and monotonically increasing revision. A creator is a member, not an arbitrary submitted email/name. Delivery and status secrets are independent random 256-bit base64url values; only lookup hashes are stored. A delivery URL `/drops/<id>#<delivery-secret>` loads a static page without sending its fragment in the initial request; an agent sends the secret in an Authorization header to `/v1/drops/:id/delivery`, never a logged query. Status uses a separate bearer secret at `/v1/drops/:id/status`; terminal lookup uses only the status-secret hash, so the route's syntactic ID does not require retaining a drop-ID mapping. Creator review routes are authenticated under `/v1/journeys/:id/drops`; delivery/status capability lookup returns no journey name/ID, roster, wraps or artifacts. Member creation returns delivery URL, independent status URL, exact expiry and an inert sharing line. A link proposal returns a proposal receipt/status URL and inert person-review line only; it allocates no delivery capacity before acceptance. Proposals accept only title/type/tags/filename, using existing artifact field validity and a total 1,048,576-byte JSON cap; server-stored proposal details are explicitly plaintext under D29. Client credentials never appear in drop URLs. Use `POST /a/:secret/drops` for proposals only, with current live-link verification, exact named metadata and a separate bounded proposal rate counter. The adding person explicitly accepts the proposal and creates the drop as its immutable creator; retain the verified suggesting agent separately. Acceptance is not delivery approval or inclusion. An authenticated member agent can instead create its own drop using its own signing/encryption identities and inherited access; a link secret alone cannot sign or assign a creator. Unaccepted proposal metadata expires after 24 hours from proposal receipt, or earlier rejection/acceptance; acceptance starts the new drop’s 24-hour clock, and replayed acceptance cannot allocate a second drop. Separate secrets keep delivery possession from conferring status/review authority; fragment/header transport reduces accidental URL disclosure.
6. **Lifecycle and races:** production Bend models `open` → `delivered` → `approved-awaiting-inclusion` → `completed`, with terminal `declined`, `cancelled`, `expired`. Anonymous delivery consumes the single delivery opportunity only after complete validated bytes atomically commit; a disconnected/oversized/invalid attempt leaves no delivered payload. At most one in-flight upload lease exists; failed leases are bounded and reclaimed, and another upload cannot overwrite a committed delivery. Approval binds drop ID, journey, creator, exact delivered-content SHA-256 digest, final reviewed metadata commitment, revision and deadline with the creator's signature. Edits cannot reuse an existing approval: explicit metadata revision clears approval and requires new review/signing; delivery bytes remain immutable. Decline/cancel/expiry cannot race into inclusion. Exact delivery/inclusion retries acknowledge the already committed result without a second artifact; changed retries conflict. Q5 ends delivery capability at the first complete committed submission/use or creation+24h, whichever is earlier: no second delivery or reopened URL. Failed attempts and URL reads do not consume it. The consumed delivery becomes the one pending review item; creator review, signed writer handoff and one inclusion may continue only until the original creation+24h deadline, with no grace period. Inclusion consumes approval and completes the workflow. At the deadline every unfinished item expires and is purged; completion/decline/cancel purge sooner. This separates a spent delivery capability from review of the submitted payload, preserving Q2/Q6 and mandatory creator approval. Creator-only review/cancel/decline applies equally to person and agent creators. Reading a URL is not consumption, approval, inclusion or renewal. Renewal of an agent link never silently extends a drop.
7. **Pending delivery crypto and uploads:** keep anonymous delivery separate from Stage 1 blob staging, which requires content-write access. Deliverers receive only a drop-specific upload encryption recipient, never a journey key. Browser delivery encrypts locally; agent delivery uses core crypto and bounded raw binary streams. The creator generates a fresh drop-specific age encryption identity and seals its private identity to the creator's existing recipient; the server stores only this sealed identity. Deliverers receive that public recipient. Pending content is opaque ciphertext with a random delivery key wrapped to the drop recipient, using versioned domain-separated authenticated data binding drop/revision, sizes and exact file manifest. The authenticated creation record binds this opaque drop context to its journey; deliverers need no journey ID. Fresh drop keys isolate anonymous staging from journey/private-artifact keys. This is temporary delivery storage, not a Stage 3 private artifact or named-recipient sharing. Body bytes/files are never stored in plaintext. A member-agent creator uses its own decryptable recipient and signing identity, never a server-held signing key or a substituted adding-person approver. Reuse 25,000,000 raw bytes per file, eight attachments per version, 1,048,576-byte complete JSON payload, path/URL validators, byte/digest checks and safe plain-text review. Metadata in a manifest is encrypted except the explicit proposal fields. Reject dishonest Content-Length, truncated/extra bytes, digest substitution, traversal, foreign blob IDs and caller action/author/grant fields; stream counters decide byte bounds. Use a separate R2 prefix with opaque keys and reference-safe cleanup. Enforce Q4: one pending delivery, eight files of at most 25,000,000 raw bytes each, ten live drops per creator (including delivered/approved pending items) and sixty delivery starts per hour per drop with bounded reclaimed leases and 429/Retry-After. Disclose plaintext proposal title/type/tags/filename and server-visible traffic/size/timing; encrypt body/file bytes. Pending delivery existence is not promised Stage 3 secrecy. No attachment is parsed/executed on the server and no upload can allocate ordinary artifact references.
8. **Approval is not inclusion:** authenticated creator approval checks current membership and exact creator identity through Bend, independent of read-only/read-write role. Inclusion is a separate operation requiring both the unconsumed matching creator signature and the including member's current D5/D34 content-write authority, current epoch/capabilities and no pending rotation. Recheck after crypto/upload I/O and inside the serialized commit. A read-only creator can approve, but gets `approved-awaiting-inclusion`, never a sequence reservation or ordinary write. A different writer cannot approve for them or change approved bytes/metadata. Q2 uses one explicit creator-selected current authorized writer, never all writers/guides. The creator signs a drop/revision/digest-bound handoff and supplies a drop-specific key wrap only to that writer after showing who receives the bytes and becomes author. This lets the writer prepare the final package before creator approval. Final approval binds that handoff and package; removal/downgrade blocks inclusion, and reselection requires fresh handoff, preparation and approval. This is temporary delivery access, not a private-artifact grant. At inclusion the authorized browser or authenticated CLI/MCP member agent decrypts the pending content, re-encrypts private-journey content under the current journey key and signs the normal artifact create as the actual including member. Public inclusion uses Stage 6's explicit readable/public format and warning; pending bytes stay encrypted until inclusion. The including member is the immutable artifact author under D38, not the anonymous deliverer or proposer; retain verified `suggested by <agent>` separately when present. Q3 follows current member parity: read-write agents may prepare/include through equivalent local crypto/signing; read-only agents may create/approve but cannot include, exactly like read-only people. The agent signs as itself and becomes the actual author when it includes. No browser/person-only gate or extra amendment decision remains; document this replacement of D29’s older sign-as-person wording in the implementation contract. Before final approval, the authorized writer prepares and signs the exact proposed artifact-create proof/envelope and attachment descriptors. The creator’s browser or authenticated agent client decrypts that final package, compares its content/files and reviewed metadata against the delivered digest and verifies the writer's signature, then signs approval binding both delivery digest and this complete artifact-create proof hash. The server can verify this exact ciphertext/proof binding without reading private content; it cannot independently prove equality of two differently encrypted plaintexts. A changed epoch, chain position, ciphertext or writer requires refreshed preparation and creator approval, never silent re-signing. Tests must mutate the writer's re-encrypted bytes before and after approval. A legitimately authorized writer who already received plaintext can independently copy it as an ordinary artifact; drop controls do not claim to recall bytes or prevent such ordinary authorized writes. Bind a new `drop.include` signed proof with exactly `format:'agent-v1'`, drop, creator, approval digest, artifact ID and predecessor revision to the artifact-create proof hash. Commit both proofs, artifact/blob references and drop completion atomically in one Durable Object transaction; generic `/log` cannot bypass this binding. Fresh IDs, exact chain positions/signatures/envelope bindings and replay of both production transitions remain required. Do not invent a second artifact-create format or let `drop.include` itself create content. An error/retry cannot leave one half committed. Final replay and archives retain verifiable approval evidence, not live delivery/status secrets, plaintext proposal text or pending upload ciphertext. Q8 inclusion creates an ordinary non-private artifact in the selected journey, initially unassigned, with an explicit visibility warning. Stage 2 placement is a separate later authorized action; drop inclusion cannot create a private artifact or specialized interview/round confirmation. Ordinary HTML/applet types are supported, with explicit later viewing through the existing Stage 5 runtime rather than execution during review.
9. **Retention and status:** all pending proposal details, ciphertext, delivery key wraps, upload leases and creator/writer routing metadata are deleted after successful inclusion, decline/cancel or expiry, with alarm retries plus access-time denial at the deadline even if cleanup is delayed. Completed artifact content follows existing artifact retention, not drop retention. Retain a seven-day terminal status tombstone keyed only by independent status hash, enum and purge deadline: no drop/journey/artifact/member IDs, title/type/tags/filename, bytes, actor, signature, exact completion time, URL or content. Status returns only `{status}` (and `expiresAt` while active); never links to the included artifact or plaintext proposal. After tombstone purge every unknown/purged status returns the same 404. Status conveys no approval/inclusion permission. Q6 accepts this enum-only disclosure to the independent status bearer, not detailed history. Creator metadata edits are allowed before final approval; preserve the original suggestion only as temporary untrusted input, never as plaintext permanent provenance. Any later metadata/package change invalidates approval and requires fresh review/signing; delivered body/files cannot be overwritten, and changed content needs a new drop. Submission consumes delivery access, not the pending review storage; delete that storage on inclusion, decline/cancel or original deadline expiry. Logs/metrics use bounded generic counters, not drop secrets or submitted fields. Test both successful cleanup and delayed/failed R2 cleanup without access resurrection.
10. **Versions and formats:** use the **next client version after the preceding stage**, with capability `agent-v1`, `X-Agent-Format` transport header and content-free protocol field `agentFormat`, in addition to every preceding-stage capability. Resolve its actual semver only when those stages ship; do not assume Stage 3 or Stage 6 versions. Update public core/client manifests, dependencies/lock and interface constants together; leave private package/rules versions unchanged unless their preceding-stage contract requires otherwise. New journeys require this minimum; existing histories are not purged or rewritten and a person guide of either role signs a monotonic client.minVersion before Stage 7 actions. Reads below that boundary retain their earlier format; Stage 7 drops/routes require the new boundary. At the new boundary, all authenticated content/control/blob/export paths and live-link internal claims must carry all required capabilities and satisfy the signed minimum; a minimum-raising request must satisfy the resulting requirements. Negotiation stays content-free. Anonymous delivery/status are deliberately nonmember capability routes: validate their supported wire format without demanding client installation/version headers from a browser, and do not thereby expose journey routes. Unsupported/missing/malformed versions/capabilities, unknown actions and a newer signed minimum fail closed before partial output. Explicitly retain 0.1.3-or-older rejection tests; unsupported-future fixtures mean the next version after Stage 7, not a fixed number. Archives use the preceding stage's strict container, preserving accepted exact proofs/approval evidence and named-field projection, never ephemeral secrets or caller-supplied read/drop indexes.
11. **Interfaces, safety and proof:** browser/CLI/MCP readers consume the core model, with exact query validation and meaningful errors. Add CLI `overview`, retain `list|search|show|comments|versions` wrappers and add matching MCP `overview`; filter input supports main/project/all, type and tag with search text by intersection. Add CLI `drop create|deliver|status|show|approve|decline|cancel|include` and MCP `drop_create`, `drop_deliver`, `drop_status`, `drop_show`, `drop_approve`, `drop_decline`, `drop_cancel`, `drop_include`, with signed creator-selected handoff available through CLI `drop handoff` and MCP `drop_handoff`. Authenticated agents use the same member-role checks for create/review/approve/handoff/include, with no browser-only inclusion restriction. Anonymous deliver/status do not initialize an approved journey connection; approved operations use existing signed request/state machinery. Local files/output paths remain explicit, no symlinks or attachment-derived host paths. Browser has member create/review/inbox and anonymous paste/upload delivery pages; show suggested details/content as escaped plain text before explicit approval and separately labelled inclusion. Provide explicit proposal accept/reject and selected-writer handoff; acceptance alone never approves delivered bytes. Show creator-editable final metadata, recipient/author identity, server-visible proposal fields, quotas, spent delivery status and the original deadline countdown. Preserve drafts/conflict messages and test reload of persisted results. Stage 4 specialized actions/confirmation remain separate, even if a delivery suggests an interview or sensemaking type. Agent links advertise read routes plus proposal instructions, never write authority. Evidence must include real CLI subprocess/MCP, browser reload, local workerd/R2 races and one same-journey client/link comparison, not only two mocks of the same selector. Negative controls remove actual production guards and must reach assertion/proof failures; AST boundary probes reject duplicate TypeScript audience/creator/inclusion decisions and stubbed Bend adapters.

## Resolved operator questions

The 2026-10-02 record closes Q1–Q9; the earlier 2026-09-03 statement that they were open is historical. The current instruction removes special agent restrictions and preserves powerful applets. These decisions are part of the body, not conditional recommendations.

1. **Q1 — proposal acceptance:** a live link proposes only. The adding person explicitly accepts to create a drop as creator, preserving suggested details and verified agent attribution. No delivery URL/upload capacity exists before acceptance; acceptance is not approval. Reject/expire unaccepted proposals and purge their metadata. Authenticated member agents may create their own drops separately.
2. **Q2 — selected writer:** a read-only creator explicitly selects one currently authorized writer. Show the temporary content audience and final author; use a signed handoff and fresh drop-specific key wrap, then package preparation and creator approval. Never expose approved deliveries to all guides/writers. Reselection requires fresh handoff and approval; removal/downgrade blocks inclusion.
3. **Q3 — member-agent parity:** member agents create and approve as themselves, using their own decryptable recipients/signatures within inherited access. Under the current direction, authorized read-write agents also include through CLI/MCP with the same checks as people; this replaces the accepted recommendation’s former browser/person-only clause. Read-only agents cannot include, and link credentials remain proposal-only, not signing authority. Creator, adding person, suggester and final author stay distinct.
4. **Q4 — capacity/disclosure:** one pending delivery; eight files, each at most 25,000,000 raw bytes; ten live drops per creator; sixty delivery starts per hour per drop with bounded leases and 429/Retry-After. Invalid/incomplete attempts do not consume delivery. Plaintext proposal title/type/tags/filename and traffic/size/timing are disclosed as server-visible; body/files are encrypted and routing/metrics minimized. Pending delivery existence is not Stage 3 private-artifact secrecy.
5. **Q5 — first submission/use or 24 hours:** delivery access ends at the first complete committed submission/use or creation+24h, whichever is earlier, with no reuse. Reading the URL and failed attempts do not consume it; exact retries only acknowledge the prior result. The one submitted payload remains reviewable for creator approval/selected-writer inclusion until the original deadline, never a new grace period. Inclusion completes/consumes approval; decline/cancel or deadline expiry purges pending data. This is the simplest interpretation preserving both single use and the accepted review/handoff workflow.
6. **Q6 — review, cancellation and retention:** only the exact creator cancels before inclusion or declines delivered content. Delete pending content/metadata immediately on inclusion, decline/cancel or expiry; retain only seven-day enum status keyed by independent status hash. The creator may edit metadata before approval; changes invalidate approval and require new review. No post-approval content overwrite, and no permanent plaintext original proposal. New content requires a new drop.
7. **Q7 — attachment parity:** text/source and visible attachment metadata are shared; binary downloads remain in member interfaces with an explicit link notice. No link download routes or byte-parity claim.
8. **Q8 — inclusion:** ordinary non-private artifact, selected journey, initially unassigned, explicit visibility warning, later authorized Stage 2 placement. No drop-created private artifact, interview label or round contribution/confirmation. Ordinary earlier-stage types include HTML/applets; review stays inert, and explicit applet viewing retains the existing Stage 5 powers without new agent/applet-specific limits.
9. **Q9 — search fields:** current-head title/tags/portable body plus visible attachment filenames/package paths in every interface. No comment/history/binary/remote-content search. Test Unicode normalization and field-specific matches; hidden names never enter link indexes.

## Remaining open questions

None within Stage 7. Stage 3 storage remains an external preceding-stage decision, not a new Stage 7 question or authorization to pick a fallback. The actual client version and final preceding-stage gate names are resolved from shipped prerequisites at implementation kickoff, not new product choices.

## Current code observations

Sources read against main 889b218: docs/ontology.md in full (including Stage 7 and appendix), decision 0001 in full, docs/journey-protocol.md in full, .work/drafts/stage-2-projects.md in full; current shared proof/artifact/transfer/rules/link modules, browser/client journey/artifact/read surfaces, server routes/types/enclave/registry/link assembly, package/test configurations, rules laws/proofs and boundary/negative-control runners. These are source observations, not Stage 7 test results.

- Current versions are 0.1.5/control-proof-v1/artifact-v1, with Stage 2 planned at 0.1.6. Main has strict Stage 0 public controls and Stage 1 artifact/blob authority and local R2. Ontology section 10's claims about absent roles, plaintext independent authority, opaque logs, skipped read-only profiles and 0.1.3 are stale relative to this code. Use code/protocol's active proof contract, not the stale appendix paths.
- packages/core/src/{controlProof,log,rules,artifacts}.ts verifies exact chain/signatures/envelope commitments and sends normalized verified inputs to compiled Bend. Ciphertext has strict separate label/artifact content shapes. Artifact creates pin their signer as author; edit/comment writer identity is distinct. Stage 7 approval/provenance cannot silently change that.
- packages/web/src/artifacts.ts and packages/client/src/journey.ts independently decode histories and build version/comment views; artifactText and filters differ. Browser searches attachment names, client does not; link flattens comments and attachment text into overview bodies. Shared reads are not already built. Character clipping in link titles/tags must not become a false parity assertion.
- packages/server/src/agentLink.ts verifies/decrypts in memory, renders PAGE_LIMIT=12,000 paged text/people, uses no-store/no-transform and disallows attachment downloads. packages/server/src/index.ts serves only GET /a/:secret, with per-link rate lookup and internal version claims. No drop schema/route/storage/approval exists; link credentials carry a decrypting age identity, not a usable signing identity.
- Renewal on upgraded journeys is signed member.renew, not the appendix's remove/add pair. Current routes require fresh person/passkey confirmation and update registry expiry without rotating or changing the URL. Ended/unknown is 404, expired is 410, unsupported link reader is 502. Preserve those behaviors and test them on every added read/proposal path.
- packages/server/src/enclave.ts serializes complete verified operations across crypto awaits, rechecks uploads after I/O, atomically commits authority/log/blob references and uses Bend for current access/version/storage lifecycle. A drop must integrate with this commit boundary, not consume metadata first in Registry and hope the artifact write succeeds later. Registry may resolve hashes/rate-limit, but it cannot independently authorize inclusion.
- Stage 1 schemas cap files at 25,000,000 raw bytes, eight attachments and complete JSON at 1,048,576 bytes. Ordinary blob staging is uploader-owned/current-write-only. Anonymous delivery needs isolated encrypted staging; widening existing blob routes to anonymous callers would be an authority regression.
- packages/core/src/transfer.ts preserves exact signed controls and live blob bytes. Its baseline archiveProof uses legacy logDefinitions for nonartifact bodies; Stage 2 plans to fix additive control projection. Stage 7 depends on that fix and must project its own accepted controls/approval evidence strictly, while excluding all ephemeral secrets and private inventory from unauthorized exports.
- scripts/check-bend-boundary.mjs parses all four consumer source trees and checks real adapters, not string markers. scripts/check-stage1-negative-controls.mjs copies tracked source into ignored disposable trees, rebuilds local outputs and distinguishes assertion/theorem failures from setup failures. Extend these patterns. Theorem rejection may exit 0: inspect the verdict, not exit alone.
- Builds order rules before core and consumers. Core has Node/workerd/browser runners; server uses workerd/local R2; browser and real client integration share port 18787 and run serially. Client subprocess tests require a fresh client build. No runtime dependency is assumed; use Web Crypto in portable core, no node: imports.

## Criterion homes and proof contract

Every Stage 7 focused suite, fixture and mutation runner below is a planned deliverable, not an existing passing test. The owning suites must assert Q1 acceptance-before-allocation/not-approval, Q2 selected-writer key-wrap isolation/reselection, Q3 person/agent RO/RW parity, Q4 exact quotas/disclosures, Q5 spent delivery with deadline-bound pending review, Q6 metadata reapproval/terminal purge/seven-day status, Q7 no link bytes, Q8 non-private unassigned inclusion and existing applet runtime powers, and Q9 every searchable field. Each criterion has one command evidence object with exit 0, its exact printed marker and real assertions. From a clean committed assembled repository with dependencies installed, run `env -i PATH="$PATH" sh -c '<run>'`, leaving HOME unset. Each command checks clean status, captures `git diff --binary HEAD -- .` before/after, demands equality and clean final status. Ignored builds/cache/scratch are permitted; evidence installs nothing, changes no tracked source/lock and hides no diff. Clean-tree gates cannot run in this authoring checkout while another draft is untracked; they are future implementation evidence, not authoring validation.

| Criterion | Observable result | Owning node | Evidence | Why here |
| --- | --- | --- | --- | --- |
| shared-reads | Portable verified audience/selection/paging across all earlier-stage content | read-contract | command | Core owns the common read result |
| agent-laws | Production Bend audiences, drop transitions, creator approval and version/inclusion separation | drop-contract | command | Rules and signed adapters ship together |
| link-parity | Real same-journey client/link read equivalence, private noninterference and bounded transport | link-service | command | Server owns link decryption/read routes |
| drop-authority | Anonymous encrypted delivery, races, current creator/writer checks, atomic inclusion/cleanup/status | drop-service | command | Server owns durable lifecycle |
| browser-agent-drops | Reloaded person create/review/approve/include and anonymous browser delivery | browser-agent-drops | command | Browser owns review and private encryption |
| client-agent-drops | Real CLI/MCP shared reads and allowed drop workflows | client-agent-drops | command | Agent interfaces own explicit file/state workflows |
| stage7-negative-controls | Executed mutations plus extended AST boundary and harness controls | integration | command | Assembled guards need cross-boundary proof |
| stage7-regression | All existing/new suites, builds, both proof modes, formats and archives | integration | command | Integrated tree owns final release gates |

Negative controls first prove each named baseline test passes, then remove one actual guard at a time in disposable ignored tracked-source copies with read-only dependency links and isolated generated rules/core/client output. Require the expected named assertion failure, and both actual production proof modes for representative Bend mutants. Missing/skipped tests, setup/syntax/module failures, already-red baselines and surviving mutants fail the runner. Exercise the runner against a missing test, setup failure and no-op survivor. Tests supply prohibited fields/IDs/secrets and assert they neither persist nor appear in any output/log; marker text alone proves nothing. Cleanup disposable trees and local servers on success/failure.

## Scope overlap review

Seven worker-sized nodes: read-contract establishes portable reads and audience integration; drop-contract follows with rules/signed lifecycle and version/fixture alignment. link-service and drop-service follow drop-contract and may run in parallel within separate server modules, but shared index.ts/types.ts/protocol/rules edits are serialized by the lead. browser-agent-drops and client-agent-drops depend on both services; independent source lanes may run in parallel, server-backed evidence may not share port 18787. integration follows both interfaces. Earlier stages are external prerequisites, not fabricated completed nodes; Q1–Q9 are settled. Q7 adds no download routes and Q8 adds no private inclusion, so the seven node ids and dependency graph remain unchanged. Agent inclusion/handoff fits the existing client/server/core lanes. Concentration in rules/core/request adapters/manifests/protocol is intentional serialized ownership, not permission for parallel conflicting edits.

All nodes reference this draft's Decisions taken, Resolved operator questions, earlier-stage prerequisites, boundaries and proof contract; docs/ontology.md Stage 7 and access table; decision 0001 amendments; docs/journey-protocol.md; and the final accepted preceding-stage contracts. Read their final code before implementation. No node widens touches without lead review; no speculative new stage formats or dependency stubs.

## Worker boundaries

### read-contract

Depends on: none.

Touches: ["packages/core/src/reads.ts", "packages/core/src/rules.ts", "packages/core/src/index.ts", "packages/core/test/stage7-reads.test.ts", "packages/core/test/stage7-fixtures.ts", "packages/rules", "docs/journey-protocol.md"]

Implement shared verified overview/list/filter/search/show/comments, full versions/author-writer distinction, visibility-before-selection, main/project/all intersections, current-head title/tags/body/visible filenames/package-path search with Unicode normalization, deterministic order, audience-safe relationship projection and bounded Unicode continuation/cursors. Integrate final Stage 3/4/6 adapters without accessing private stores in link mode. Rules decide audience/deletion/participation; TypeScript validates/copies/projects. Add portable fixtures with private author/subject interviews, public/private copies, rounds, archived projects, deleted/recovery records, all active types and hostile metadata. Differential tests add hidden private material and demand identical link outputs/counts/cursors/errors. Verify core unchanged in Node/workerd/browser. No drop storage, transport routes, UI or stage rebuild.

### drop-contract

Depends on: read-contract.

Touches: ["packages/core/src/drops.ts", "packages/core/src/controlProof.ts", "packages/core/src/log.ts", "packages/core/src/rules.ts", "packages/core/src/types.ts", "packages/core/src/transfer.ts", "packages/core/src/versions.ts", "packages/core/src/index.ts", "packages/rules", "packages/core/test/stage7-drops.test.ts", "packages/core/test/stage7-archive.test.ts", "packages/core/test/stage7-fixtures.ts", "packages/core/package.json", "packages/server/package.json", "packages/web/package.json", "packages/client/package.json", "package-lock.json", "packages/server/src/types.ts", "packages/web/src/journey.ts", "packages/client/src/journey.ts", "docs/journey-protocol.md"]

Using settled Q1–Q9 and current member-agent parity, define exact drop/proposal/delivery/approval/handoff/inclusion formats, signatures/digests/revisions, key wrappers and compiled production lifecycle adapters. Implement creator approval independent of content role and inclusion dependent on both approval and current inherited writes/epoch/rotation/deadline. Couple accepted drop.include to the exact normal artifact-create proof in replay and strict archives; no encrypted second action or caller bootstrap. Add symbolic laws/proofs for real production functions including private link exclusion, nonmember delivery not authority, unchanged creator, digest-bound approval, one delivery/inclusion, spent-delivery rejection with pending review until the original deadline, terminal/deadline denial and version gates. Own next-client-version-after-preceding-stage/agent-v1 headers/types/manifests/lock alignment and minimal fixture plumbing. Existing signed minima/histories remain valid without purge. Test Web Crypto round trips, tampered approvals/content/keys/extras, RO creator versus writer, member-agent RO/RW parity, invalid agency and archive exclusion of ephemeral secrets. No server effects or UI.

### link-service

Depends on: drop-contract.

Touches: ["packages/server/src/agentLink.ts", "packages/server/src/index.ts", "packages/server/src/types.ts", "packages/server/test/stage7-link.test.ts", "packages/server/test/stage7-parity.test.ts", "packages/server/test/stage7-fixtures.ts", "packages/server/README.md", "packages/client/test/stage7-parity.integration.test.ts", "docs/journey-protocol.md"]

Replace link-only views with verified core reads; implement all named GET routes, exact queries, core paging/continuations/revision conflicts, no-store/security headers and shared live-link rate limit. Recheck current adding-member/link access on each route/page, preserve lifecycle/renewal/update errors and prohibit control/blob/private-vault access. Run one local persisted journey through actual JourneyClient and link HTTP reads; compare reconstructed stable semantic results for overview/list/filter/search/show/comments/versions/attribution across all queries. Transport URL/access hints are the only declared nonsemantic differences; no content truncation/exclusion is normalized away. Exercise private canaries in every link surface and public provenance restrictions. Add browser same-model assertion later in integration. Coordinate shared route/type edits with drop-service; no binary download routes, anonymous drop storage or capability-selection authority changes owned there.

### drop-service

Depends on: drop-contract.

Touches: ["packages/server/src/drops.ts", "packages/server/src/enclave.ts", "packages/server/src/index.ts", "packages/server/src/types.ts", "packages/server/src/registry.ts", "packages/rules", "packages/server/test/stage7-drops.test.ts", "packages/server/test/stage7-fixtures.ts", "packages/server/README.md", "docs/journey-protocol.md"]

Implement proposal accept/reject and member-create routes with acceptance replay protection and 24-hour unaccepted-proposal cleanup, isolated anonymous encrypted staging and independent status lookup. Registry hash/rate routing supplies no inclusion authority. Durable Object serializes Bend-authorized transitions, upload leases/current checks and two-proof artifact/drop completion transaction; R2 staging is isolated and reference-safe. All rejection paths preserve persistent state, no partial log/artifact. Gate all authenticated interfaces and internal link claims with agent-v1/current minimum; content-free negotiation remains available. Anonymous routes authenticate only their narrow secret/wire format, never broaden /v1 middleware exceptions to journey writes or recovery sessions. Member mutations retain origin/CSRF or signed-agent request protection; delivery capability requests validate exact fields/body/digests and bounded streams. Recheck expiry/removal/downgrade/link ending at creation/approval/inclusion and after upload I/O. Test concurrent deliveries, approve/cancel/expire/include races, RO person/agent creator plus explicitly chosen person/agent writer, proposal acceptance versus approval, ten-live-drop/sixty-start quotas and server-visible metadata disclosures, forged creator/suggester, stale approval, wrong journey/epoch, exact retry versus changed retry, clock boundary, restart replay, plaintext-metadata purge, content-free status and delayed R2 cleanup. Prove delivery capability is spent on submission without deleting the review item; reject reuse, retain review only until the original deadline, and purge terminal metadata with seven-day enum-only status. No renderer/client changes.

### browser-agent-drops

Depends on: link-service, drop-service.

Touches: ["packages/web/src/drops.ts", "packages/web/src/main.ts", "packages/web/src/journey.ts", "packages/web/src/artifacts.ts", "packages/web/src/style.css", "packages/web/e2e/stage7-agent-drops.spec.ts", "packages/web/e2e/stage7-fixtures.ts", "packages/web/README.md"]

Use core reads for list/search/detail/comments/overview without alternate filters. Implement member drop create/inbox/review and anonymous fragment delivery paste/upload, local encryption, exact plain-text proposal/content review, explicit creator approval and separate authorized inclusion and explicit selected-writer handoff. Accept/reject link proposals before member creation and allow creator metadata edits before approval. Display proposal-plaintext/traffic disclosure, accepted quotas, non-private/unassigned inclusion warning, recipient/author identity, spent delivery status and original deadline countdown. RO creators can approve but cannot reserve, stage ordinary blobs or include; other writers cannot bypass creator approval. Preserve source files and review revisions, report stale conflicts and redact secrets on navigation/sign-out; no analytics/referrers or plaintext persisted browser caches. E2E reload every delivery/approval/inclusion/decline/cancel/expiry result and verify stored artifact/author/suggester, chosen-writer isolation, no second delivery after submission, pending review survival only to the original deadline, metadata reapproval and seven-day status purge. Exercise hostile markup/filenames/URL, anonymous no-membership/no-journey-read, sign-in return without leaking secret, current access races, pending rotation and unsupported capabilities without partial views. Preserve existing private/public/app runtime boundaries, credentials and header/footer. No package versions or deployment.

### client-agent-drops

Depends on: link-service, drop-service.

Touches: ["packages/client/src/drops.ts", "packages/client/src/journey.ts", "packages/client/src/artifacts.ts", "packages/client/src/cli.ts", "packages/client/src/mcp.ts", "packages/client/src/index.ts", "packages/client/test/stage7-agent-drops.integration.test.ts", "packages/client/test/stage7-fixtures.ts", "packages/client/README.md"]

Implement exact shared read/overview/filter and approved drop CLI/MCP surfaces; anonymous delivery/status operate without connection, member mutations use existing verified signed requests. Do not let the CLI autoapprove a delivered artifact or convert link credentials into a signing identity. Keep explicit local files, byte limits, no symlinks/remote fetch, named-field MCP projection and actionable update/conflict/errors. Agents create/review/approve/handoff/include with their own crypto/signing identities and exactly inherited member access. Implement selected-writer handoff and authorized agent inclusion; never require a browser/person solely because the actor is an agent. Expose pending proposal accept/reject to the authenticated adding member through existing signed request machinery, never the link secret alone. Real subprocess and stdio MCP tests against local workerd exercise anonymous delivery, current RO/RW inherited access, creator versus suggester/adding person, direct write denials, single use, approved waiting, authorized read-write agent inclusion, RO agent inclusion denial, proposal acceptance not approval, selected-writer key-wrap isolation, consumed delivery with retained deadline-bound review, accepted quotas/expiry/cancel/status/purge, omitted/malformed agent-v1, unchanged approval/state credentials and no persisted caller extras. Test fixtures only, no real Keychain. No manifests or unrelated network changes.

### integration

Depends on: browser-agent-drops, client-agent-drops.

Touches: ["scripts/check-bend-boundary.mjs", "scripts/check-stage7-negative-controls.mjs", "packages/core/test", "packages/server/test", "packages/web/e2e", "packages/web/src/stage0-versions.test.ts", "packages/client/test", "packages/core/src/versions.ts", "packages/core/package.json", "packages/server/package.json", "packages/web/package.json", "packages/client/package.json", "package-lock.json", "packages/core/README.md", "packages/server/README.md", "packages/web/README.md", "packages/client/README.md", "docs/journey-protocol.md"]

Verify final preceding-stage readiness and implemented settled decisions, shared reader adoption and next-version/agent-v1 alignment across manifests, protocol responses, all headers/routes/archive readers and future fixtures. Extend AST checks for audience-before-selection, creator/approver/writer/handoff separation, lifecycle/deadline/single-use/current inclusion and required real Bend calls; exempt only exact schema/crypto/identity adapters, never whole consumer functions. Disposable mutants must weaken private exclusion/count/cursor/direct-ID equivalence; selector/search/paging parity; link live/version checks; secret independence; creator versus writer; approval digest/revision; RO/current D34/rotation; delivery/inclusion single use, retained review after submission without deadline extension, proposal acceptance not approval, and atomicity; upload size/digest/ownership; cleanup/status redaction; payload/caller extras; unsigned provenance; unknown actions/capabilities; inert review rendering/no URL fetch while preserving explicit Stage 5 applet runtime powers; member-agent access parity, selected-writer isolation, metadata reapproval and accepted quotas. Representative Bend mutations fail focused assertions and both PROOF modes. Inject duplicate TypeScript decisions and stub adapters to prove structural gate failure. Run actual same-journey browser/client/link reads, encrypted archive round trip with approved inclusion/live blobs and no ephemeral data, and private-storage-option exclusion cases. Execute all preceding-stage and Stage 7 gates serially where ports overlap; no skipped safety tests for the chosen private-storage implementation. Report exact commands/exits/markers, every named mutant's assertion/proof failure and clean final tree.

## Evidence commands

These become node-owned `kind: command` evidence on promotion/decomposition. Each expects exit 0 and output_includes equal to its final marker. Focused commands use timeout_ms 600000; integration commands use timeout_ms 3600000. The referenced focused suites/runners must first be implemented. Commands run from a clean committed assembled root with dependencies installed; run local-server suites serially and stop servers on every exit. Earlier-stage gates remain mandatory in regression; no HOME, live services, deployment or package installation.

### shared-reads command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run test -w @ai-wayfinding/core -- test/stage7-reads.test.ts
npm run test:workers -w @ai-wayfinding/core -- test/stage7-reads.test.ts
npm run test:browser -w @ai-wayfinding/core -- test/stage7-reads.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 7 shared-reads assertions passed\n"
'
```

### agent-laws command

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
npm run test -w @ai-wayfinding/core -- test/stage7-drops.test.ts test/stage7-archive.test.ts
npm run test:workers -w @ai-wayfinding/core -- test/stage7-drops.test.ts
npm run test:browser -w @ai-wayfinding/core -- test/stage7-drops.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 7 agent-laws assertions passed\n"
'
```

### link-parity command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run build -w @ai-wayfinding/client
npm run test -w @ai-wayfinding/server -- test/stage7-link.test.ts test/stage7-parity.test.ts
npm run test -w @ai-wayfinding/client -- test/stage7-parity.integration.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 7 link-parity assertions passed\n"
'
```

### drop-authority command

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
npm run test -w @ai-wayfinding/server -- test/stage7-drops.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 7 drop-authority assertions passed\n"
'
```

### browser-agent-drops command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run test:e2e -w @ai-wayfinding/web -- e2e/stage7-agent-drops.spec.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 7 browser-agent-drops assertions passed\n"
'
```

### client-agent-drops command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run build -w @ai-wayfinding/client
npm run test -w @ai-wayfinding/client -- test/stage7-agent-drops.integration.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 7 client-agent-drops assertions passed\n"
'
```

### stage7-negative-controls command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run build -w @ai-wayfinding/client
node scripts/check-stage7-negative-controls.mjs
node scripts/check-bend-boundary.mjs --rules
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 7 stage7-negative-controls assertions passed\n"
'
```

### stage7-regression command

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
npm run test -w @ai-wayfinding/core -- test/stage7-reads.test.ts test/stage7-drops.test.ts test/stage7-archive.test.ts
npm run test:workers -w @ai-wayfinding/core -- test/stage7-reads.test.ts test/stage7-drops.test.ts
npm run test:browser -w @ai-wayfinding/core -- test/stage7-reads.test.ts test/stage7-drops.test.ts
npm run test -w @ai-wayfinding/server -- test/stage7-link.test.ts test/stage7-parity.test.ts test/stage7-drops.test.ts
npm run test:e2e -w @ai-wayfinding/web -- e2e/stage7-agent-drops.spec.ts
npm run test -w @ai-wayfinding/client -- test/stage7-parity.integration.test.ts test/stage7-agent-drops.integration.test.ts
node scripts/check-stage1-negative-controls.mjs
node scripts/check-stage2-negative-controls.mjs
node scripts/check-stage3-negative-controls.mjs
node scripts/check-stage4-negative-controls.mjs
node scripts/check-stage5-negative-controls.mjs
node scripts/check-stage6-negative-controls.mjs
node scripts/check-stage7-negative-controls.mjs
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 7 stage7-regression assertions passed\n"
'
```

The Stage 3–6 runner names above are required integration entry points to the final accepted preceding-stage negative controls, not claims they exist today. At implementation kickoff map their final accepted commands to these entry points without skipping any gate or weakening its assertions. Missing prerequisites fail the regression command and keep this stage incomplete.

## Acceptance criteria <!-- work:criteria -->
- shared-reads: When portable core tests run in Node/workerd/browser, verified overview/list/filter/search/show/comments and versions use audience-before-selection, main/project/all intersections, current-head title/tags/portable-body/visible-filename/package-path search with NFC and locale-independent lowercase matching (not comments/history/binary/remote content), deterministic order, immutable author/actual writer, safe references and 12,000-byte Unicode paging; deleted/recovery/foreign/hidden records never appear, adding private author/subject/copy data changes no link bytes/counts/cursors/errors, public attribution/origin restrictions hold and malformed/unknown data fails before partial output under either Stage 3 storage option.
- agent-laws: When production Bend compiles and both PROOF.bend modes run through scripts/bend.mjs, both print ALL PROOFS CHECK for inherited viewer access/private link exclusion, proposal acceptance without approval or pre-acceptance delivery authority, nonmember delivery without journey authority, exact person/agent creator approval independent of content role, digest/revision-bound selected-writer handoff and approval, person/agent RO/RW inclusion parity, one delivery/inclusion, spent delivery after submission with pending review only to creation+24h, terminal/deadline denial, current authorized inclusion/rotation/version gates and coupled artifact/drop replay; strict crypto/signature/payload/archive tests reject substitution, forged approval/attribution, extras and ephemeral-secret export while preserving preceding-stage laws.
- link-parity: When local persisted same-journey server/client parity tests run, actual client and link reconstructed overview/list/filter/search/show/comments/versions match for identical non-private audience and selectors including visible attachment-name/package-path search without hiding content differences; web uses the same core contract, private artifacts/interviews/copies and their existence stay absent, all routes/page headers fit PAGE_LIMIT with preserved queries, stale snapshots refresh and live-access/expiry/revocation/update/rate checks precede output; mutation/key/vault/binary-download requests are denied and links explicitly direct attachment downloads to member interfaces rather than claiming byte parity.
- drop-authority: When local workerd/R2 suites run, link proposals allocate no delivery capacity before explicit adding-member acceptance, which binds that member as creator with a distinct verified suggester and cannot approve content or create duplicate drops; person/agent member creation and creator-only approval obey inherited access, anonymous delivery stores bounded ciphertext without journey authority, and quotas enforce one pending delivery, eight files of at most 25,000,000 raw bytes, ten live drops per creator and sixty starts/hour/drop with 429/Retry-After; first complete submission spends delivery while review/selected-writer handoff remains available only until original creation+24h, failed attempts do not consume and retries cannot deliver/include twice; only the selected current writer receives a handoff key wrap, cannot replace approval/change approved bytes, and reselection or final metadata/package changes require fresh approval; current access/epoch/rotation/deadline/capabilities are rechecked at atomic two-proof inclusion of one non-private initially unassigned artifact; decline/cancel/expiry/restart and delayed cleanup cannot resurrect access, pending metadata/content is purged on completion/decline/cancel/expiry, unaccepted proposals expire within 24 hours, and independent seven-day enum-only status then uniform 404 persist no plaintext proposals, caller extras or secrets.
- browser-agent-drops: When browser e2e reloads persisted outcomes, explicit link-proposal acceptance precedes creation but never approves content; anonymous paste/upload encrypts, and inert review shows escaped hostile content, creator-editable final metadata, server-visible proposal/traffic disclosure, accepted quotas, selected recipient/final author, spent delivery and original deadline countdown; exact creator approval/reapproval stays separate from selected-writer inclusion, RO creators cannot write and other writers cannot bypass consent; non-private initially unassigned inclusion displays its visibility warning and leaves project/interview/round actions separate, explicit HTML/applet viewing retains Stage 5 powers without executing during review; sign-in/current access/conflict/rotation/update/expiry/cancel/seven-day status purge works without partial views, unintended review fetch/execution, private-artifact leakage, credential changes or header/footer regressions.
- client-agent-drops: When built CLI subprocess and stdio MCP tests run against local workerd, shared overview/read filters including visible filenames/package paths match core and anonymous deliver/status need no journey connection; authenticated agents create/review/approve/handoff with their own identities and inherited access, authorized read-write agents include as actual authors without a browser/person gate, read-only agents cannot include exactly like read-only people, and explicit proposal accept/reject cannot turn acceptance into consent; selected-writer key wraps, exact approval/reapproval, accepted quotas, spent delivery/original deadline, non-private unassigned inclusion and enum-only status/purge follow the same server contract; exact named inputs/local paths reject unauthorized inclusion/automatic consent/foreign IDs/caller extras/oversized or substituted bytes, expired/removed/downgraded access and unsupported agent-v1/actions without journey-write elevation, persisted plaintext or approval/credential regressions.
- stage7-negative-controls: When the disposable runner and extended AST gate run, every named weakened private-audience/selection/search-field/paging/live-link/version/secret/proposal-acceptance/creator/digest/revision/selected-writer/metadata-reapproval/RO/inheritance/quota/rotation/spent-delivery/deadline/atomicity/upload/cleanup/seven-day-status/provenance/payload/inert-review guard reaches its expected assertion failure; person/agent access-parity fixtures reject injected person-only inclusion restrictions and explicit applet-view fixtures reject new Stage 7 runtime restrictions, representative actual production Bend mutants also reject both proofs, duplicate TypeScript decisions/stubbed adapters fail --rules, and missing tests/setup failures/survivors fail the harness while tracked files remain unchanged.
- stage7-regression: When the assembled accepted preceding-stage plus Stage 7 tree runs all package/runtime suites, typechecks/builds, both proof modes, all boundary modes, preceding-stage/Stage 7 negative controls, real browser/client/link parity and encrypted inclusion/blob/archive round trips pass serially where ports overlap, settled Q1–Q9 behaviors including authenticated agent inclusion parity and unchanged explicit Stage 5 applet powers pass together; next-client-version-after-preceding-stage/agent-v1 headers/manifests/fixtures agree, 0.1.3-or-older and future minimums fail closed, histories are not purged/rewritten, private exclusion holds for the chosen Stage 3 storage and alternate adapter contract, and evidence requires no HOME/live services/deployment or tracked changes.

## Operator decisions (recorded 2026-09-03)

- **Scope:** every stage is in MVP scope. The numbered questions above are still open.

## Operator decisions, part 2 (recorded 2026-10-02)

- **Q5 expiry:** a drop ends at whichever comes first: 24 hours after creation, or when it is submitted or used. No reuse.
- Every other recommendation (questions 1–4 and 6–9) is **accepted as written**.

