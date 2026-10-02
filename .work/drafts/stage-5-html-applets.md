# Stage 5: HTML and applets

## Summary <!-- work:summary -->
Deliver HTML and browser-only applet artifacts that run native authored HTML/JavaScript automatically when viewed, in an opaque sandboxed iframe on a separate origin, modelled on pi-artifacts. Support normal browser DOM, CSS, frameworks, external assets, new-tab links, popups and downloads within the recorded sandbox/CSP. Applets read only data their current viewer can read in the containing journey through a parent postMessage bridge; HTML has no journey API. Credentials and raw keys stay outside the frame. Provide the browser-encrypted, member-shared applet store, with an irreversible shared-write lock after private-capable discovery or private input. Private applets have only in-memory state. Browser, CLI and MCP support source authoring/versioning/inspection and member-authorized store inspection/editing; CLI/MCP never execute applets. This remains a draft, not implementation approval or passing evidence. Q1–Q9 are settled by the operator decisions below.

## Why <!-- work:rationale -->
Ontology section 9 Stage 5, section 3's HTML/applet/data definitions, section 6's access rows and section 10's built-code gaps define this work. Decision 0001 D9–D13, D27–D31, D34, D36, D38–D40 and D44 apply, with the recorded operator decisions taking precedence over this draft's earlier interpreter, absolute no-network, consent and resource-limit recommendations. D39 grants applet data reads as the current viewer, not the code author. D36 still excludes private artifacts, their existence and metadata from unauthorized viewers and every agent-link response. D44's subject read exception grants neither edits nor access to others. D5 governs ordinary shared writes; guide/facilitator status alone grants none. Agents get exactly their affiliated member's current access, with no Stage 5 agent-only restrictions or limits.

All audience, inherited-access, store-write authority, predecessor, deletion, readiness, private-source separation and replay decisions belong in production Bend functions in packages/rules, stated in LAWS.bend and proved by PROOF.bend. TypeScript verifies formats, signatures, commitments, identity/epoch bindings and cryptographic results; copies named fields; handles transport, parsing and effects; and adapts verified Bend results. CSP (Content Security Policy) restricts browser operations, not permission authority. Extend scripts/check-bend-boundary.mjs without weakening preceding-stage checks. ControlProof remains the only signed shared authority; encrypted content, guest messages and caller indexes cannot confer grants.

A hostile or careless caller must not execute artifact code on the application origin, access the parent DOM or its keys, gain application API authority from cookies or a sandbox message, submit forms, navigate the top-level viewer, impersonate another viewer or the artifact author, enumerate another member's private artifacts through errors/counts/IDs, persist private-derived results through the shared-store bridge, gain writes from read-only/guide/link status, replay stale instances, bypass rotation/revision checks, persist arbitrary caller fields, execute parent-side parser extensions/SQLite writes, or obtain partial content through an unsupported client. Test each disallowed path with hostile input and assert it does not survive storage/output. Native script/DOM execution, permitted external resource loads, new-tab links/popups and file downloads are intended capabilities, not failing tests. Private output may be downloaded and then added by a person as an ordinary artifact; the runtime never uploads it or treats a download as store-write permission. This is not whole-device data-loss prevention: resource URLs and escaped tabs can disclose already-delivered data, downloaded copies cannot be recalled, and arbitrary native compute is not metered. The remaining ambiguity about literal app-host traffic is recorded as open question R1.

### Earlier-stage dependencies and release boundary

- Stages 0 and 1 are the built foundations at main `889b218e7e272983354ab68d62ed99e5d763f9a4`: inherited roles/control proofs, artifacts, binary encryption, versions/comments/deletion, data views and encrypted archives. Reuse them, do not revive legacy authority paths.
- Stage 2 projects is being built with client 0.1.6. Stage 5 must preserve main/project/all selectors, archived-project reads and the distinction between project placement and read authority. Projects grant no extra runtime access or store-write authority.
- Stage 3 supplies the accepted private-storage implementation and its viewer audience adapter. Stage 5 neither chooses nor reopens its storage contract. Only viewer-readable data reaches that viewer's frame; private artifacts never enter shared histories/stores/link output, and unauthorized callers cannot discover their existence. Private records are not ordinary journey envelopes and a journey key does not protect author privacy. Privacy fixtures exercise the accepted Stage 3 backend, including unavailable private data, without exposing vault/storage identifiers.
- Stage 4 rounds must supply the verified interview subject read exception and its revocation/relationship semantics. Applet data access must use that audience result; neither facilitator status nor contribution confirmation adds permission. Applets do not create interviews, edit rounds or save contributions. Those APIs remain Stage 4's work.
- Stage 6 public journeys and cross-journey sharing is later work. Test public/nonmember audience fixtures and private-public separation now, but activate neither public routes nor sharing. A future destination copy has an independent store namespace, not access to a source journey/store. The shared store stays member-only, including for future public applets; anonymous/nonmember fixtures have no store access. Stage 6 must preserve this accepted Q6 boundary. Never weaken D36 for a public applet.
- Stage 7 owns full core read parity, full client/link parity and drops. Stage 5 supplies narrow shared executable-artifact projections, data access and safe link notices only; it does not claim full D27 parity or turn links into executable viewers.
- Release uses **next client version after the preceding stage**, with capability `html-v1`, alongside every preceding-stage capability. Resolve the actual version only against the accepted preceding-stage release during implementation. Do not reserve a number or omit intervening stage requirements.

Out of scope: choosing Stage 3 storage; changing D36 privacy; public activation/conversion/listing/joining; drops; generic server code, build-time/CLI dependency fetching, npm execution or server-side applet execution; generic applet artifact/control writes; profile/key/recovery redesign; account deletion; unrelated hardening backlog; independent security certification. Native browser loading of authored external scripts/styles/media is in scope under Q1/Q7, not CLI execution or server dependency installation. No deployment, provisioning, package publication, live Keychain/journey access or remote action counts as evidence. Preserve the app header/footer and inert Stage 1 viewers.

## Decisions taken

The operator decisions at the end settle Q1–Q9. The following contract replaces the affected recommendations throughout this draft. It retains D36, viewer-bound access and the private-data shared-write lock. The six node ids, dependencies and eight criterion ids are unchanged: runtime ownership still belongs to html-runtime and the parent data/store bridge still belongs to browser-html. Replacing the interpreter changes their deliverables and proof obligations, not the graph.

1. **Separate static runtime origin (Q1).** Add `packages/runtime` containing a trusted native frame bootstrap and bridge client, with no app imports, credentials or server execution. Require `ARTIFACT_RUNTIME_ORIGIN`, an absolute HTTPS origin distinct from every application/API origin; `https://runtime.wayfinding.support` is a proposed host, not provisioning authority. Reject same-origin configuration, URL credentials, paths, queries, fragments and unsupported schemes. Local tests use 18788 for runtime and 18787 for app/API. Load a constant static shell URL without journey/artifact/member ids, source, secrets or signed URLs. No app fallback, account/journey routes, authored-content logging or redirects to the app. Fail closed on absent/mismatched configuration. Deliver verified/decrypted source from the parent only after binding the frame; the static host never receives source or private data for storage or rendering.

2. **Native browser execution (Q1/Q3).** Match pi-artifacts' native HTML rendering, not its annotation-only nonce policy. Authored HTML/JavaScript runs in the frame's browser realm when viewed, including inline/external scripts, native DOM/events, CSS and browser-compatible frameworks. There is no QuickJS, guest interpreter, virtual DOM, DOM-patch protocol, element/style allowlist or parser-based JavaScript emulation. The trusted bootstrap establishes the data bridge before parsing authored markup into its own sandboxed document. Keep the runtime response CSP in force over that document; do not execute source in the parent, use an app-origin `srcdoc` replacement or put plaintext source in a server response/URL. Browser tests must show the bridge and CSP survive the chosen native document-loading method. Frameworks still obey the recorded CSP: a framework needing fetch or form submission will not work merely because it runs natively. No Run button or per-launch picker/consent is introduced.

3. **Sandbox/CSP, permitted output and actual isolation (Q1/Q7).** Set both iframe and response sandbox to `allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads`; `allow-downloads` is the necessary addition to pi-artifacts' reference tokens for the operator's explicit download decision. Omit `allow-same-origin`, forms and every top-navigation/storage-access token. Use `referrerpolicy="no-referrer"`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and frame ancestors restricted to the app. The response CSP is `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads; default-src * data: blob:; script-src * 'unsafe-inline'; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors <app origin>`. The app admits the runtime host in `frame-src` without widening other application policies. Links use new tabs with `noopener noreferrer`; popup tests verify no usable opener into the app. Native blob/file downloads work without a trusted-parent export approval step. Preserve ordinary native APIs within browser/CSP limits rather than installing interpreter host APIs. Do not add a policy that silently disables approved resources, popups, downloads or frameworks.

   This policy blocks fetch/XHR/WebSocket/EventSource/beacon connections and form submissions in the executable document, and the sandbox denies top navigation and same-origin DOM/storage access. It is not an absolute no-network policy: external scripts, images, CSS/fonts/media, frame-local navigation and escaped tabs can cause requests, and URL-bearing resources can carry applet-readable values. No claim of per-script memory/CPU bounds or total app-host request exclusion is made. The parent invalidates the data/store instance on frame navigation/load; it never authenticates an escaped tab or replacement document as a new instance. Guest-relayed messages still have only the original instance's bound authority and write-lock state. The app/API keeps its existing signed authorization and rejects sandbox-origin authority/CORS escalation. Whether Q7's app-origin wording requires blocking every app-host resource/navigation request, rather than blocking execution/authority there, remains R1.

4. **Strict artifact source and immutable type (Q1/Q8).** Activate `html` and `applet` in existing artifact create/version with immutable typeHash, author, actual writer, predecessor, tags, attachments and deletion. Source uses strict `{kind:'html',html}` or `{kind:'applet',html}` when it fits the existing complete-record envelope framing. To avoid reintroducing Q8's rejected source limit, also support `{kind:'html',sourceAttachment}` or `{kind:'applet',sourceAttachment}` where `sourceAttachment` names exactly one existing signed/encrypted attachment descriptor holding UTF-8 HTML source, up to the existing 25,000,000-byte file limit. Require exactly one source representation; reject unknown fields, dangling/foreign attachment references, unsupported commitments and mismatched proofs before launch. Reuse existing attachment encryption, byte verification, authorization, archive and upload/download paths. Parent source/comment/CLI views stay inert. Only the selected source document executes on viewing; unrelated attachments/packages never autorun. Authored external script/style references load natively under the runtime policy; neither build nor CLI resolves/installs them. Versions cannot change HTML into applet to acquire journey access. Private executable artifacts use only Stage 3 authority/storage; D44 reads do not grant edits.

5. **Viewer-bound postMessage bridge (Q2/Q3).** Verify relevant shared history and Stage 3/4 audience projections before launch. Create a random 256-bit nonce and MessageChannel. Transfer one port only after checking the exact iframe `contentWindow`, static-shell readiness, strict handshake schema and nonce. Opaque `event.origin` can be `null`; it is not authentication. The initial `postMessage` transfer may target `*` only for that pinned window, never a broadcast. Install the bridge before authored code, reject replacement/duplicate handshakes/ports and ignore other windows. Parent-owned instance state binds containing journey, stable artifact, exact version, current viewer/access snapshot and lifecycle generation. Native guest code is untrusted, including code that changes its own `wayfinding` object; only the parent validates requests and authorizes operations. HTML gets no journey port/API; applets get `data.list`, `data.read`, `store.get`, `store.put` only. Requests are exactly `{v:1,id,op,args}`; responses are `{v:1,id,ok:true,value}` or `{v:1,id,ok:false,error}`. Copy named fields through strict operation schemas; reject extra/prototype fields, invalid request ids, cycles and uncloneable values with nonsensitive errors. Transfer copied values/bytes, never keys, cookies, wraps, access proofs, private-storage URLs, parent objects or host callbacks. There is no new applet-specific message-size, outstanding-request or operation-timeout cap. Preserve existing transport limits and store snapshot cap. A new iframe load/navigation, version/access change or teardown closes the parent port and invalidates all handles and pending responses. Recheck the parent-owned generation at dispatch and after awaited work; a replacement document cannot re-handshake into the old instance. Do not rely on guest unload notifications or assume the browser cannot relay a guest-held port before the parent observes navigation.

6. **Containing-journey data API (Q2/Q3/Q8).** List/read only undeleted `data` artifacts the current viewer can read in the containing journey, including project/archived-project data, their permitted private data and D44 subject data. No cross-journey discovery, author impersonation, forbidden private rows/counts/tombstones/storage ids or guessed-id distinctions. Unknown, unauthorized, deleted and stale handles share the same unavailable result. Recheck authority after asynchronous decrypt/parse and before delivering responses. Preserve existing JSON/CSV/TOML/YAML/SQLite format contracts and read-only parent parsers; native guest code may compute on copied data without gaining parent parser authority. SQLite uses the existing local sql.js worker with `PRAGMA query_only=ON`, `trusted_schema=OFF` and generated validated-table reads; the bridge accepts no SQL, extensions, ATTACH, file/URL imports or writes. Test hostile format tags/keys/formula-like cells, malformed SQLite and SQL write/extension attempts. Keep existing data-view/upload protections, workers and paging without imposing the rejected new guest/data-result limits or silently truncating data. Expose raw source/bytes on explicit request as data, never parent markup.

7. **Irreversible shared-write lock and allowed file export (Q4/Q5).** Production Bend decides instance classification `shared-only` → `viewer-private` from verified audience facts; it never reverses. Private code starts viewer-private and has no store namespace. Before any private/interview-subject-only input or private-capable discovery, including list counts, empty lists, unavailable results or parser errors, classify viewer-private and cancel queued unsent shared writes. A viewer-wide list always takes this conservative transition, regardless of whether any private row exists; an explicit shared-only API scope lets code list shared inputs without probing for private existence. This is an API argument, not a person-facing picker. Public/shared code may read viewer-private data as its viewer; code authorship adds no denial or grant. If a shared write is already submitted, classify immediately but withhold private values/metadata until acknowledgment or verified reread settles its outcome. An unresolved commit blocks private delivery and requires safe refresh; aborting fetch does not undo a server commit. Every later store put returns a nonsensitive write-locked error. Non-private code can still read an otherwise authorized shared store after classification; private code has neither get nor put namespace.

   Keep a trusted status notice and Stop/restart outside the frame, not a Run/consent gate. Reload/restart discards native document memory, ports, handles and pending private results and starts from verified source. Guest flags or re-handshakes cannot declassify. Neither private applets nor the host persist private runtime memory/checkpoints; opaque-origin native storage receives no special persistence service. Downloading private-derived results is explicitly allowed. The person can then add the file through ordinary artifact authoring and its normal access rules; there is no automatic upload, generic artifact-write bridge or store-lock override. Tests prove the locked instance's data/store bridge cannot persist private canaries, metadata or namespaces in the platform's shared store/link projections for a second viewer, while an intentional file download works. The lock does not claim to stop deliberate disclosure through the approved external assets/links/download channels or an independent member tool.

   The lock is a parent-owned bridge rule for this instance, not browser-wide information-flow tracking. Native code may retain or relay copies through permitted external resources or escaped tabs; Stop/restart cannot erase those copies. The parent never grants a popup or replacement document its own authenticated bridge, and forwarded guest requests cannot change viewer, journey, version or operation authority. Test unsolicited popup/window handshakes and old-generation requests, not an impossible guarantee that arbitrary guest code cannot relay already-readable values or retain them outside the frame. No restart inherits a port, handle or private cache from the host; this is not a claim that guest-controlled external state is clean.

8. **Encrypted member-shared store (Q4/Q6/Q8).** Non-private applets have one namespace per containing journey and stable artifact, shared across versions but not cross-journey copies. HTML/private applets and anonymous/nonmember public viewers have no store. Agents use exactly their affiliated member's read/write access; signed CLI/MCP store operations add no special restrictions. Agent links remain read-only; an authorized live member-affiliated link may inspect the same non-private store its member can read, through the existing deliberate live-decryption mechanism, never private artifacts. This is a projection for the member, not anonymous publication of store values. Preserve member-only store access if/when Stage 6 activates public code.

   An absent store reads as empty with revision null and creates no row. Use encrypted `{type:'applet.store-content',typeVersion:1,body:{entries}}` and signed `applet.store` ControlProof with exact public body `{format:'html-v1',artifact,author,actor,version,predecessor,bytes}`. Author is immutable, actor is the real signer, version is the observed current executable version, predecessor is the prior accepted store proof sequence or null, and bytes is complete plaintext snapshot length. Entries are exactly `{key,value}`, unique and sorted by JavaScript code-unit key order; values are JSON with keys copied into null-prototype objects, rejecting `__proto__`, `constructor`, `prototype` at every depth. Put replaces the snapshot using its observed predecessor; an empty array clears it. Reuse the existing 1,048,576-byte complete-record limit as the store size cap; add no 65,536-byte cap, entry/key/depth quota or runtime quota. Encoding and keyed replay validate complete plaintext size/fields/binding; server checks declared size, ciphertext framing/length and existing request caps but cannot validate encrypted JSON plaintext.

   Reuse envelopeHash/chain/epoch binding, fresh 96-bit AES-GCM nonce and a store-specific 256-bit key derived from journey epoch key bytes with HKDF-SHA256: salt UTF-8 `wayfinding/applet-store/v1`, info UTF-8 canonical JSON `{journey,artifact,epoch}`. Import nonextractably, discard derivation bytes, and never give keys to frame/server. Verify derivation across core runtimes and preserve historical epoch wraps for authorized reads. Server stores ciphertext and non-private authority metadata only. Private namespaces never use shared proofs/envelopes/ids, preserving D36. The instance privacy lock applies equally to any viewer; it is not a CLI/agent content rule or a promise to prevent a member's independent intentional disclosure.

9. **Current authority, conflicts and lifecycle (Q6/Q9).** Store writes are D5 content writes, not D17 project metadata: require a live effective read-write member, current capabilities/epoch, undeleted non-private applet/current version and current predecessor. Agents mirror their affiliated member's current access; add no original-limit or agent-only Stage 5 test that denies what the member may do. Guide/project/facilitator/confirmation status alone grants none. Browser puts additionally require a current shared-only instance. Enclave serializes verification/commit and atomically stores proof, snapshot reference and revision, rechecking access/version/epoch/rotation. Stale revision/version returns 409, access denial 403, malformed fields 400, oversize 413 and unsupported client 426 with no effects. Exact committed retries remain access/version-gated and idempotent; altered stale proofs conflict. No silent last-write-wins merge. Removal/expiry/logout/journey change/deletion/new version tears down instances; downgrade disables writes, and every response rechecks reads. Runtime navigation also tears down its bridge. Deletion removes live ordinary runtime/store references but preserves signed encrypted integrity history. Rotation blocks writes until an authorized survivor re-encrypts under the current epoch; authorized read-only members retain historical reads. No future wraps go to removed members; old copies/keys cannot be recalled.

10. **Archives, member links and CLI/MCP (Q5/Q6/Q9).** Preserve `format:'artifact-v1',version:1` archives and preceding-stage private/round separation. Exact `applet.store` proofs and encrypted snapshots use existing `controls`; source attachments use existing blob entries. No store blobs, caller indexes or private namespaces/counts in shared exports. Decode stores with their epoch/domain key, verify complete history/payloads and reconstruct revision/authority through replay; reject missing envelopes/source blobs, duplicates, foreign namespaces, cryptographic failures and unknown extensions. Instance classification and memory never enter shared history/archive. Intentional downloaded output is a separate file, not an archive of runtime memory.

   Live member-affiliated agent links receive inert paged non-private HTML/applet source and authorized store snapshots with a browser-viewing notice, using running-server capabilities and preceding-stage selectors/pagination. They never execute, receive a runtime port, obtain viewer-private artifacts/existence, expose executable download routes or write. Verify current member access at every page and preserve PAGE_LIMIT, Unicode continuation, expiry/revocation/no-store and existing live decryption. Store read parity does not grant any link writes or anonymous public store access. CLI/MCP use ordinary signed create/version/show/attachment APIs and `applet store show|put`, `applet_store_show`, `applet_store_put`. Put requires observed store revision/current applet version and explicit local JSON within the same store cap as browser writes. Private authoring uses Stage 3 paths. CLI/MCP execute neither source nor dependencies and add no independent agent access rules. Stage 7 still owns full read/link parity and drops.

11. **Complete stage-relative version gate.** Add `HTML_FORMAT='html-v1'`, header `X-HTML-Format` and named `htmlFormat` in subject/create/protocol/update adapters. Core/client/interface release is the next client version after the preceding stage, with every preceding-stage capability plus html-v1. Existing histories are not purged/silently upgraded; a person guide of either role must sign client.minVersion to the complete boundary before first HTML/applet/store action. Raising minimum itself satisfies the resulting capability set; minimum never decreases. Gate all content/control/blob/private/round/project/export paths, not only runtime. Content-free authenticated negotiation stays available; unknown/malformed/unsupported versions, capabilities, actions, payloads and archives fail before partial content. Links use running-server capabilities/update-server errors. Derive future-version fixtures from the resolved release and retain 0.1.3-or-older rejection. Align public core/client versions/dependencies/lock; keep private package versions except the new runtime manifest. Bridge API version 1 is distinct from release negotiation.

12. **Exact bridge API, native UI (Q2/Q3/Q8).** Expose `wayfinding.data.list({scope?,cursor?})`, `wayfinding.data.read({handle,version,cursor?,table?,raw?})`, `wayfinding.store.get({})`, `wayfinding.store.put({entries,predecessor})`. Scope is `viewer` by default (private-capable and locks shared writes before response) or explicit `shared` (shared inputs only, no excluded-private totals). Omitted raw is false; omitted cursor starts at zero and omitted table selects the first allowed SQLite table. Requests never accept a journey id, URL, SQL, principal or code author. Metadata is copied `handle`, `version`, `title`, `format`; reads return copied parsed data/raw bytes and opaque continuation cursors tied to instance/source version/viewer, invalidated on teardown. Reuse preceding-stage paging, without new 1 MiB-result, 1,000-row, 32-request or ten-second applet ceilings. There are no virtual node/render/style/raster/compute/memory quotas. Native HTML/DOM/CSS/events/images/media/downloads follow the browser sandbox/CSP, not parent render allowlists. Existing inert viewers/raster validation and parent data-worker safety controls remain unchanged. HTML receives no `wayfinding` journey API; native guest objects can neither modify parent state nor add broker operations.

## Answered questions Q1–Q9

Each question is closed by the operator's recorded decision, not by the draft's earlier recommendation. The 2026-09-03 note at the end is retained as a historical record; the 2026-10-02 answers supersede its open-question status.

1. **Q1 compatibility:** native browser HTML/JS in a separate-origin opaque sandbox, modelled on pi-artifacts; interpreter/virtual DOM removed. Frameworks work within its CSP.
2. **Q2 data scope:** exactly the current viewer's readable data in the containing journey, via the parent postMessage bridge.
3. **Q3 launch:** automatic when viewed; no Run button, picker or per-launch consent.
4. **Q4 private persistence:** private applets have only in-memory state and no store namespace.
5. **Q5 private results:** irreversible shared-write lock; file download followed by a person's ordinary artifact upload is permitted.
6. **Q6 store audience:** members only; affiliated agents have exactly their member's access with no extra restrictions/limits. Authorized member-affiliated link store reads use existing live decryption; anonymous store access and all link writes remain absent.
7. **Q7 output:** external assets, new-tab links/popups and downloads allowed; connect-src connections, forms, top-level navigation and app-origin execution/authority stay blocked. Literal app-host request exclusion remains R1.
8. **Q8 limits:** no new applet/interpreter/DOM/compute/data-result quotas. Existing file limit is 25,000,000 bytes; shared snapshots reuse the existing 1,048,576-byte complete-record cap, with attachment-backed source avoiding a smaller executable-source cap.
9. **Q9 interfaces:** CLI/MCP author/inspect source and inspect/edit stores under the same member access; neither executes applets.

## Remaining open question <!-- work:decisions -->
- R1-app-origin-traffic: Does Q7's "the app origin" mean no artifact execution, parent DOM access or authenticated API authority there (the draft's implementation interpretation), or no request/navigation/resource load to any application/API host at all? pi-artifacts' accepted `default-src *`/`script-src *` policy does not exclude app-host subresources or escaped-tab destinations, and frame-local navigation is not top-level viewer navigation. Complete app-host traffic exclusion cannot be claimed from the specified CSP. This is a residual boundary ambiguity, not a reopening of native execution, external assets, links or downloads; implement and test access isolation without silently inventing a resource blacklist, and do not claim the stronger exclusion until resolved.
  tripwire: Before runtime activation or a claim that every app-host request is blocked.
  decides: Dan

## Current code observations

Sources were read against main `889b218e7e272983354ab68d62ed99e5d763f9a4`: docs/ontology.md, all of decision 0001, docs/journey-protocol.md, the Stage 2 draft, and current contracts/rules, server authority/routes/links, browser/client adapters/viewers and evidence infrastructure. These are source observations, not Stage 5 passing evidence. Stage 3 storage is supplied by its accepted contract, not chosen by this draft. Other concurrent drafts are outside this task. These baseline observations are historical, not a fresh audit of main.

- packages/core/src/artifacts.ts strictly defines Stage 1 types; HTML/applet are reserved rather than working runtimes. Existing data formats already include JSON, CSV, TOML, YAML and SQLite. Versions bind immutable type/author and exact attachments, so activation belongs in these decoders/type commitments, not an unchecked new item string.
- packages/web/src/artifact-viewer.ts makes Markdown/links inert and validates raster bytes. packages/web/src/data-worker.ts has local parsing/read-only SQLite foundations and bounded display; preserve those controls and test the applet-facing projection separately. Neither module is an executable-artifact security boundary today.
- packages/server/src/index.ts supplies the application HTML CSP with self scripts/connect and WASM support. It is not the separate runtime policy. The native runtime needs its own sandbox response CSP and host/configuration; authored source cannot use the app router fallback.
- packages/rules/{rules.bend,rules.d.mts,LAWS.bend,PROOF.bend}, packages/core/src/rules.ts and packages/server/src/enclave.ts implement verified inherited access, signed controls and artifact/blob authority. Enclave serializes operations before atomic storage commits. Extend these actual paths for stores/readiness rather than adding a plain authority table or TypeScript role checks.
- packages/core/src/transfer.ts preserves exact signed controls/live blobs in a versioned encrypted archive. Its control projection must follow the preceding stages' complete controlDefinitions, not the older legacy logDefinitions. The Stage 2 draft already identifies this integration dependency; Stage 5 must verify it, not reintroduce a parallel archive authority.
- packages/server/src/agentLink.ts is paged read-only JSON, verifies/decrypts while a live link is available, and does not execute content or offer blob downloads. Stage 5 must preserve PAGE_LIMIT, Unicode continuation, recovery/deletion exclusion and preceding-stage project selectors. Private Stage 3 records must be absent even when an adding person's own private data is otherwise readable to their agent.
- Baseline public core/client version is 0.1.5 with control-proof-v1/artifact-v1, not the ontology appendix's old 0.1.3. Stage 0 inherited-access and Stage 1 artifact/blob code also supersede several appendix gaps. Projects/private artifacts/rounds/runtime/public activation are not present at this baseline. The Stage 2 draft is a plan for 0.1.6, not shipped baseline code. This draft therefore does not pin the Stage 5 client number.
- The protocol's account-specific PRF and memory-only-key narrative differs from current persistent browser-key code, as the ontology already notes. That separate discrepancy is not permission to pass keys into a frame and is outside this stage.
- pi-artifacts reference read for this revision: `/Users/blah/.pi/agent/npm/node_modules/@centerforagenticai/pi-artifacts/src/server.ts:770–850` uses native raw-HTML response sandbox/CSP (its annotation path has a different nonce policy); `/Users/blah/.pi/agent/npm/node_modules/@centerforagenticai/pi-artifacts/web/view.html:256` embeds native HTML with script/popup/escape sandbox tokens and no allow-same-origin. Its broad resource directives and connect-src denial are not absolute no-network isolation. This plan adds a separate host, encrypted parent source delivery, viewer-bound journey bridge and the allow-downloads token required by Q7; it does not copy unencrypted raw server delivery.
- Root build orders rules before consumers; generated rules.mjs and build/cache outputs are ignored. Core tests use Node/workerd/browser; server tests use local workerd/R2; browser e2e and client local-server tests share 18787 and must run serially. Add the isolated static runtime at 18788 with guaranteed teardown and local-only fixtures. No live services or HOME should be needed.

## Criterion homes and proof contract

Every focused suite, runtime workspace and negative-control runner below is a planned deliverable, not an existing passing gate. Every criterion has one command evidence object with real assertions, exit 0 and its exact printed marker. Run from a clean committed repository root with installed pinned dependencies using `env -i PATH="$PATH" sh -c '<run>'`. HOME/live services/remote provisioning are not prerequisites. Check clean status and capture `git diff --binary HEAD -- .` before and after, demand equality and clean final status. Generate only ignored build/cache/scratch outputs; never install dependencies, rewrite tracked source/manifests/locks, hide diffs or modify the production tree for mutation evidence. No command is runnable proof until its named tests/scripts exist and prerequisite stages and the runtime activation tripwire are resolved.

Bend laws prove symbolic authority/replay/privacy classification over production functions, not cryptographic or browser-engine isolation. Runtime tests must separately observe native scripts/framework rendering, permitted external assets/popups/downloads, denied connection/form/top-navigation attempts, frame/port and parser-worker teardown and cross-viewer persistence. Canary assertions are operation-specific: approved asset/tab/download requests are expected; fetch/XHR/WebSocket/EventSource/beacon/form attempts in the executable document must not reach their canaries. Observe baseline endpoint availability so an unreachable canary cannot fake CSP enforcement. App-origin tests prove access/DOM/authority isolation, not unresolved total host-traffic exclusion. A missing canary observation, no script execution, setup error or syntax error cannot count as a successful negative control. The runner copies tracked source to disposable ignored trees, verifies passing baselines, weakens named production guards, and demands the specified assertion/proof failures. It must fail for missing tests, surviving mutants and setup failures, clean up on success/failure and report each mutation/test/exit/failure.

| Criterion | Observable result | Owning node | Evidence | Why here |
| --- | --- | --- | --- | --- |
| html-contract | Strict executable/store contracts, verified privacy adapters, archives and stage-relative version gate | html-contract | command | Portable core owns signed formats and audience adapters |
| html-laws | Production Bend audience/store/private-result/readiness laws and proofs | html-contract | command | Rules and their named-field adapters ship together |
| html-authority | Serialized current store authority, ciphertext persistence, races and inert read-only link projection | html-authority | command | Server owns durable effects and link decryption |
| html-runtime | Separate-origin native sandbox/bridge, permitted assets/popups/downloads, denied connections/forms/top navigation and safe parent data parsing | html-runtime | command | New static runtime owns browser isolation |
| browser-html | Automatic viewer-bound launching, private-data write lock, intentional file output and persisted store workflows | browser-html | command | Browser owns keys, current viewer and broker lifecycle |
| client-html | Real CLI/MCP source/store workflows with inherited access, explicit inputs and no execution | client-html | command | Agent interfaces own signed calls and update feedback |
| stage5-negative-controls | Executed weakened guards, canary controls and extended AST Bend boundary | integration | command | Integrated tree owns cross-boundary proof |
| stage5-regression | All preceding-stage and new package/runtime/build/proof/archive/browser/client gates | integration | command | Assembled release owns final regressions |

## Scope overlap review

Six worker-sized nodes. html-contract establishes production rules, strict core formats, stage-relative capability/manifests/lock, archive store-envelope decoding and shared audience/data adapters. html-authority follows it. html-runtime also follows it and can build the isolated runtime independently of server effects. browser-html follows both authority and runtime; client-html follows authority and can run in parallel with browser implementation, not concurrently on shared server test ports. integration follows both interfaces. Runtime implementation touches no app credentials/server authority; authority touches no guest execution; the browser broker alone combines the viewer's verified data and keys. packages/rules, shared protocol, transport adapters, fixture plumbing, manifests/lock and exports are intentionally serialized overlaps, not independent ownership. No node widens its touches without lead review. All nodes reference this draft, ontology Stage 5/access/technical appendix, decision 0001 including amendments, docs/journey-protocol.md and accepted preceding-stage contracts. Q1–Q9 are closed. Earlier-stage prerequisites and R1's activation tripwire are external blockers, not fake nodes with evidence that merely prints approval.

## Worker boundaries

### html-contract

Depends on: none within Stage 5. External prerequisites: completed accepted Stages 2–4 contracts, including Stage 3 storage and D44 audiences. Q1–Q9 are settled; use their recorded outcomes and record their supersession of conflicting earlier recommendations/protocol wording in the in-scope protocol documentation. R1 blocks the stronger traffic claim/activation, not format implementation.

Touches: ["packages/rules", "packages/core/src/html.ts", "packages/core/src/appletStore.ts", "packages/core/src/artifacts.ts", "packages/core/src/controlProof.ts", "packages/core/src/log.ts", "packages/core/src/rules.ts", "packages/core/src/types.ts", "packages/core/src/versions.ts", "packages/core/src/transfer.ts", "packages/core/src/index.ts", "packages/core/test/stage5-html.test.ts", "packages/core/test/stage5-store.test.ts", "packages/core/test/stage5-privacy.test.ts", "packages/core/test/stage5-archive.test.ts", "packages/core/test/stage5-fixtures.ts", "packages/core/package.json", "packages/server/package.json", "packages/server/src/types.ts", "packages/server/src/index.ts", "packages/web/package.json", "packages/web/src/journey.ts", "packages/web/src/artifacts.ts", "packages/client/package.json", "packages/client/src/journey.ts", "packages/client/src/artifacts.ts", "packages/runtime/package.json", "package.json", "package-lock.json", "packages/core/test", "packages/server/test/stage5-fixtures.ts", "packages/web/e2e/stage5-fixtures.ts", "packages/client/test/stage5-fixtures.ts", "docs/journey-protocol.md"]

Activate strict HTML/applet types and exact named-field store actions/payloads; implement the verified core adapters and production Bend decisions for audience/data selection, inherited store authority, private-source/session classification, version/current-artifact/epoch/revision/readiness and lifecycle/deletion. Add laws/proofs that private classification cannot return to shared-only, private/subject-only input closes shared writes, HTML gets no data/store, read-only/guide/link status cannot write, foreign/hidden/deleted data is unavailable, and signed replay cannot infer grants from guest/payload fields. Preserve Stage 2 placement and Stage 4 subject-read-only authority. Bind the accepted Stage 3 adapter without exposing storage/vault identifiers and run its real privacy regression. Add attachment-backed executable source, strict one-source binding and encrypted archive round trips up to the existing file limit; test same-access member/agent data and store projections, including member-affiliated link reads without private existence. Preserve the existing archive container while adding exact store-proof projection and epoch/domain-specific envelope decoding; implement actual encrypted round trips retaining verified store snapshots/history without private records. Own initial core/client version/dependency/lock/capability/type/fixture plumbing, not server effects/UI. Run focused portable tests in all three core runtimes and archives in Node. Read Bend guide before editing Bend; use scripts/bend.mjs with HOME unset.

### html-authority

Depends on: html-contract. External prerequisites: completed Stage 3 private exclusions. Q4/Q6/Q9 settle private-stateless/member-only store and member-equivalent agent interfaces; no public activation.

Touches: ["packages/rules", "packages/server/src/enclave.ts", "packages/server/src/index.ts", "packages/server/src/types.ts", "packages/server/src/agentLink.ts", "packages/server/test/stage5-store.test.ts", "packages/server/test/stage5-link.test.ts", "packages/server/test/stage5-versions.test.ts", "packages/server/test/stage5-fixtures.ts", "packages/server/wrangler.jsonc", "packages/server/README.md", "docs/journey-protocol.md"]

Use signed /log, existing serialized Durable Object authority and exact encrypted snapshot bindings, not a guest/URL-authorized store service. Atomically persist only currently authorized proof/payload/state/reference changes and recheck current identity, inherited role, epoch/rotation, artifact/version, predecessor, capacities and all required capabilities at commit. Test overlapping writers, queued downgrade/removal/expiry/rotation/deletion/version changes, exact retry and altered stale retries; rejected requests leave SQL/R2/history unchanged. Store neither plaintext applet values nor private code/data/namespaces, and redact logs/errors. Gate every existing/new content path consistently while negotiation stays content-free. Fresh-object replay/export must retain exact verified state. Update inert bounded link projections and selectors with html-v1, source notices, no executable routes/private content/counts/store writes and member-equivalent non-private store reads; preserve PAGE_LIMIT/Unicode/expiry/revocation and deliberate decryption. Add configuration validation/app frame-src plumbing only; runtime assets and authored source are never served through the app fallback. Extend transport Bend rules if needed without TypeScript duplicate role/audience decisions.

### html-runtime

Depends on: html-contract. Q1/Q7/Q8 settle native compatibility, approved outward channels and removal of extra runtime limits. R1 remains a runtime activation/stronger-claim tripwire.

Touches: ["packages/runtime/src", "packages/runtime/public", "packages/runtime/index.html", "packages/runtime/vite.config.ts", "packages/runtime/tsconfig.json", "packages/runtime/vitest.config.ts", "packages/runtime/playwright.config.ts", "packages/runtime/test", "packages/runtime/e2e", "packages/runtime/README.md", "packages/web/src/data-worker.ts", "packages/web/src/stage5-data.test.ts"]

Build the constant separate-origin trusted bootstrap, native source-document loading and strict postMessage/MessageChannel bridge client. Declare test/test:e2e/build/typecheck scripts through html-contract-owned manifest alignment. Runtime has no app imports/keys/API authority. Authored code intentionally executes natively inside the opaque frame, automatically on viewing. Test inline/external scripts, native DOM/CSS/events and a framework fixture, including attachment-backed source. Enforce the exact sandbox/headers/CSP, with allow-downloads and no allow-same-origin; verify response policy survives document loading and cannot be widened by authored meta tags. Observe permitted external script/style/image/media requests, new-tab/popups with no usable opener and actual downloaded file bytes. Separately prove denied connection APIs, forms, top navigation, parent DOM/storage/key access and app API authority. Native frame navigation invalidates the parent bridge and pending responses; replacement documents and escaped tabs cannot establish a new authenticated instance. Guest forwarding/port relay never widens the original instance's authority or resets its write lock. No interpreter, virtual renderer, DOM/style allowlist, private-output blacklist or new CPU/memory/DOM/raster/message quota. Stop/restart closes frames/ports; do not claim browser-native infinite loops are safely interruptible or metered. Run Chromium/Firefox/WebKit against the real separate static host and operation-specific local canaries; no fake shell substitutes for this evidence. Extend existing parent data-worker projections and read-only SQLite hostile tests without weakening inert viewers/upload/data-parser safety or adding rejected applet result limits. Document native capabilities, connect-src limitations, approved disclosure risk and R1; no app-origin fallback.

### browser-html

Depends on: html-authority, html-runtime. External prerequisites: accepted Stage 3 storage and Stage 4 subject audiences working end-to-end. Q2–Q6 settle automatic viewer-bound reads, stateless private code, member-shared store and the private-data write lock; runtime activation observes R1.

Touches: ["packages/web/src/html-runtime.ts", "packages/web/src/applet-broker.ts", "packages/web/src/applet-store.ts", "packages/web/src/artifact-viewer.ts", "packages/web/src/main.ts", "packages/web/src/artifacts.ts", "packages/web/src/journey.ts", "packages/web/src/style.css", "packages/web/src/stage5-broker.test.ts", "packages/web/e2e/stage5-html.spec.ts", "packages/web/e2e/stage5-privacy.spec.ts", "packages/web/e2e/stage5-fixtures.ts", "packages/web/playwright.config.ts", "packages/web/README.md"]

Implement browser source create/edit/version/comment/delete, automatic viewing/launch, exact data API, shared-store view/write/conflict/size feedback, private-write-lock notice and Stop/restart. Support embedded and encrypted-attachment source within existing file/framing limits. No Run button or picker/consent step. Main/source/comment views stay inert; failed runtime configuration shows an actionable error with no same-origin fallback. Verify state before launch; bind current viewer and exact version; gate each pending data response/write through production Bend. Decrypt/derive keys only in parent, never in frame. Mark private classification before private-capable discovery or delivery, cancel queued unsent shared writes, and settle already submitted commits before private delivery. Forbid guest resets, private code namespaces and private-derived persistence through the locked store bridge. Tests exercise accepted Stage 3 storage, unavailable private data, own-private versus another viewer versus guide/facilitator versus D44 subject, project/archived data, member-equivalent read-only/read-write agents and affiliation downgrade/removal/expiry. A default viewer-wide list locks writes even when empty; explicit shared-only lists never expose hidden totals. Run canary public-app fixtures without activating Stage 6; a public applet run by a private-data author cannot persist private canaries/metadata through its locked shared-store bridge for a second viewer or link projection. Prove intentional private-result file download works and subsequent ordinary person upload remains separate. Approved outgoing asset/link/download traffic is not covered by the shared-store lock. Reload persisted shared store and encrypted history after accepted writes; race downgrade/rotation/deletion/new version against queued messages. Attempt spoofed windows/nonce/ports, prototype/extra-field messages, store snapshots and server requests exceeding existing caps, direct guessed IDs, data parser escape, navigation/re-handshake and hidden count probes. Do not reject an otherwise valid frame message merely for exceeding a removed applet-specific quota. Teardown on logout/access changes and never reuse cached private results. Preserve header/footer, Stage 0/1 controls, Stage 2 selectors and Stage 4 contribution confirmation. No generic artifact-write broker or new private-store backend.

### client-html

Depends on: html-authority. External prerequisite: accepted preceding-stage private client storage/audience contract. Q9 settles source/store CLI/MCP surfaces and member-equivalent agent access.

Touches: ["packages/client/src/html.ts", "packages/client/src/appletStore.ts", "packages/client/src/artifacts.ts", "packages/client/src/journey.ts", "packages/client/src/cli.ts", "packages/client/src/mcp.ts", "packages/client/src/index.ts", "packages/client/test/stage5-html.integration.test.ts", "packages/client/test/stage5-fixtures.ts", "packages/client/README.md"]

Extend existing artifact create/version/show/export workflows for strict HTML/applet source from explicit text/local files and inert output. Implement `applet store show|put` and `applet_store_show`/`applet_store_put`, requiring observed store revision and current applet version for put, explicit local JSON input and no server/browser execution. Private artifacts use only the selected Stage 3 paths; no private namespace or metadata travels through shared endpoints. Build CLI before real subprocess/stdio tests against local workerd/R2. Exercise matching person/affiliated-agent read-only and read-write access, member downgrade/removal/expiry, current epoch/rotation, stale revision/version, malformed inputs/extras/oversize, update gates, project selectors and encrypted export. Assert no content/package/URL is executed/fetched, keys do not appear in output and agent approval/credentials stay unchanged. Source show is not a claim of executable viewer parity. No manifests or generic applet-write server, no agent-specific access inventions.

### integration

Depends on: browser-html, client-html.

Touches: ["scripts/check-bend-boundary.mjs", "scripts/check-stage5-negative-controls.mjs", "packages/core/test", "packages/server/test", "packages/runtime/test", "packages/runtime/e2e", "packages/web/e2e", "packages/web/src/stage5-broker.test.ts", "packages/client/test", "packages/core/src/versions.ts", "packages/core/package.json", "packages/server/package.json", "packages/runtime/package.json", "packages/web/package.json", "packages/client/package.json", "package.json", "package-lock.json", "packages/core/README.md", "packages/server/README.md", "packages/runtime/README.md", "packages/web/README.md", "packages/client/README.md", "docs/journey-protocol.md"]

Verify/complete stage-relative version and full capability alignment, ignored outputs/local test servers, runtime dependency/build ordering, archive store-envelope decoding and inherited preceding-stage boundaries. Extend AST Bend boundary for audience/store/classification/replay/readiness decisions with actual required production Bend calls; detect duplicate equality/role/membership/private filtering and stub adapters, exempting only exact format/crypto/render adapters, never whole modules. Implement disposable mutation runner with baseline assertions and harness controls. Mutations must weaken only prohibited paths under the recorded decisions: HTML data denial; viewer versus author binding; Stage 3 hidden artifact/metadata/count/links; D44 read-only subject; private classification before discovery/delivery, including empty/unavailable results, monotonicity, queued write cancellation and in-flight commit/private-delivery serialization; code-private namespace exclusion; inherited role/guide/link store denial; predecessor/current version/epoch/rotation/atomicity; source/payload/signature/extra-field bindings; opaque-origin/response-sandbox isolation and app API authority denial; connect-src/form/top-navigation controls; allowed-popup opener isolation; download enablement and exact downloaded bytes; native source-document CSP retention; spoofed windows/ports/nonces; existing transport/store-size/parser/SQLite protections, with no interpreter memory/compute/DOM quota mutant; delete/teardown; capability/unknown action/archive gating. Representative production Bend mutants must fail focused assertions and both proof modes; TypeScript duplicate/stub fixtures must fail --rules. Browser isolation mutants must produce a specific forbidden connection/form/top-navigation/access leak; allowed-feature mutants must fail a named native script/framework/asset/popup/download assertion, not merely boot. Do not treat permitted resource requests or intentional downloaded private output as leaks. Prove a removed private write lock persists a distinctive canary, while baseline blocks it before and after empty/private-capable discovery and in-flight commits. Execute full preceding-stage suites, all new runtime/browser/client gates, archive/store round trips and negative controls after the last edit. Document exact native capabilities, existing file/store limits, Q1–Q9 outcomes, intentional-output risk and R1. Report exact command/exit and incomplete blockers; no deployment or new backlog work.

## Evidence commands

Each command becomes one node-owned `kind: command` evidence object on later promotion/decomposition, with `expect.exit: 0` and `expect.output_includes` equal to its final marker. Focused commands use `timeout_ms: 600000`; integration commands use `timeout_ms: 3600000`. Every named new test/script/package command must be delivered first. Run serially when 18787/18788 overlap; all tests/runners guarantee server/worker cleanup on success/failure. Browser binaries and pinned dependencies are installed prerequisites, never downloads inside evidence.

### html-contract command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run test -w @ai-wayfinding/core -- test/stage5-html.test.ts test/stage5-store.test.ts test/stage5-privacy.test.ts test/stage5-archive.test.ts
npm run test:workers -w @ai-wayfinding/core -- test/stage5-html.test.ts test/stage5-store.test.ts test/stage5-privacy.test.ts
npm run test:browser -w @ai-wayfinding/core -- test/stage5-html.test.ts test/stage5-store.test.ts test/stage5-privacy.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 5 html-contract assertions passed\n"
'
```

### html-laws command

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
npm run test -w @ai-wayfinding/core -- test/stage5-store.test.ts test/stage5-privacy.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 5 html-laws assertions passed\n"
'
```

### html-authority command

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
npm run test -w @ai-wayfinding/server -- test/stage5-store.test.ts test/stage5-link.test.ts test/stage5-versions.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 5 html-authority assertions passed\n"
'
```

### html-runtime command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run typecheck -w @ai-wayfinding/runtime
npm run build -w @ai-wayfinding/runtime
npm run test -w @ai-wayfinding/runtime
npm run test -w @ai-wayfinding/web -- src/stage5-data.test.ts
npm run test:e2e -w @ai-wayfinding/runtime
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 5 html-runtime assertions passed\n"
'
```

### browser-html command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run build -w @ai-wayfinding/runtime
npm run test -w @ai-wayfinding/web -- src/stage5-broker.test.ts
npm run test:e2e -w @ai-wayfinding/web -- e2e/stage5-html.spec.ts e2e/stage5-privacy.spec.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 5 browser-html assertions passed\n"
'
```

### client-html command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run build -w @ai-wayfinding/client
npm run test -w @ai-wayfinding/client -- test/stage5-html.integration.test.ts
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 5 client-html assertions passed\n"
'
```

### stage5-negative-controls command

```bash
env -i PATH="$PATH" sh -c '
set -eu
test -z "$(git status --porcelain)"
before=$(git diff --binary HEAD -- .)
npm run build:rules
npm run build -w @ai-wayfinding/core
npm run build -w @ai-wayfinding/runtime
npm run build -w @ai-wayfinding/client
node scripts/check-stage5-negative-controls.mjs
node scripts/check-bend-boundary.mjs --rules
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 5 stage5-negative-controls assertions passed\n"
'
```

### stage5-regression command

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
npm run typecheck -w @ai-wayfinding/runtime
npm run typecheck -w @ai-wayfinding/web
npm run typecheck -w @ai-wayfinding/client
npm run build
node scripts/check-bend-boundary.mjs --build
node scripts/check-bend-boundary.mjs --guidance
npm run test -w @ai-wayfinding/core
npm run test:workers -w @ai-wayfinding/core
npm run test:browser -w @ai-wayfinding/core
npm run test -w @ai-wayfinding/server
npm run test -w @ai-wayfinding/runtime
npm run test:e2e -w @ai-wayfinding/runtime
npm run test -w @ai-wayfinding/web
npm run test:e2e -w @ai-wayfinding/web
npm run test -w @ai-wayfinding/client
npm run test:integration -w @ai-wayfinding/client
npm run test -w @ai-wayfinding/core -- test/stage5-html.test.ts test/stage5-store.test.ts test/stage5-privacy.test.ts test/stage5-archive.test.ts
npm run test -w @ai-wayfinding/server -- test/stage5-store.test.ts test/stage5-link.test.ts test/stage5-versions.test.ts
npm run test:e2e -w @ai-wayfinding/web -- e2e/stage5-html.spec.ts e2e/stage5-privacy.spec.ts
npm run test -w @ai-wayfinding/client -- test/stage5-html.integration.test.ts
node scripts/check-stage1-negative-controls.mjs
node scripts/check-stage2-negative-controls.mjs
node scripts/check-stage3-negative-controls.mjs
node scripts/check-stage4-negative-controls.mjs
node scripts/check-stage5-negative-controls.mjs
after=$(git diff --binary HEAD -- .)
test "$before" = "$after"
test -z "$(git status --porcelain)"
printf "Stage 5 stage5-regression assertions passed\n"
'
```

The Stage 2–4 runner names above are preceding-stage deliverable dependencies, not claims that they exist at main 889b218. If an accepted preceding-stage spec supplies a different exact runner name, align this command to that delivered gate before promotion; do not silently skip a stage. The full Stage 0 tests/proofs are included in package/full-proof gates. All full suites must discover the new tests; focused repeats supplement, never replace, a full named gate.

## Acceptance criteria <!-- work:criteria -->
- html-contract: When portable Stage 5 suites run with accepted prerequisite contracts and recorded Q1–Q9 outcomes, strict embedded/attachment-backed HTML/applet source and store payloads, signed bindings, immutable author/type, current revisions/epochs, current-viewer rather than author audiences, member-equivalent agent reads/writes, member-affiliated non-private link store reads, D36 hidden metadata/existence exclusion, HTML data denial, D44 subject-read-only access, monotonic private classification, encrypted source/store/archive round trips and the next client version after the preceding stage/html-v1/full-capability gate pass; forged, stale, foreign, deleted, unsupported, malformed/extra-field/dangling-source or caller-index inputs fail before partial content, with private storage using the accepted Stage 3 contract rather than shared envelopes.
- html-laws: When production Bend functions compile and PROOF.bend runs normally and with --verdict through scripts/bend.mjs, both print ALL PROOFS CHECK for current-viewer/member-equivalent agent access, HTML versus applet data authority, D36/D44 privacy, irreversible private-capable classification/no shared write, private-code namespace exclusion, member-only current applet stores, D5 read-only/guide/link-write separation, member-affiliated link store reads, revision/version/epoch/rotation/deletion and complete html-v1 readiness while preserving preceding-stage laws consistent with the recorded outcomes; consumers call these functions rather than duplicate decisions in TypeScript.
- html-authority: When local workerd/R2 Stage 5 authority/link tests run, only current authorized signed store actions atomically persist ciphertext/verified state within the reused complete-record store cap; stale/concurrent/removed/expired/downgraded/rotation/deleted/version-changed/extra-field attempts change nothing, current exact retry is access-gated, fresh-object replay/export verifies, negotiation precedes content, and member-affiliated links return inert bounded non-private source and member-authorized store reads with no private metadata/counts, executable routes, anonymous store publication or writes and unchanged selectors/expiry/revocation.
- html-runtime: When runtime unit and Chromium/Firefox/WebKit end-to-end suites use a real distinct static origin, automatic native inline/external scripts, DOM/CSS/events, framework, assets, new-tab/popups with no usable opener and downloads of exact expected bytes work; the opaque iframe/response sandbox and recorded CSP deny connection APIs, forms, top-level viewer navigation, parent DOM/storage/key access and app API authority, survive native source loading and close the bridge on frame navigation; strict nonce/port schemas and existing safe parent JSON/CSV/TOML/YAML/SQLite parsers pass, prohibited attempts make no requests to their operation-specific canaries, and no interpreter, virtual renderer or new guest memory/compute/DOM/message/result quota is introduced or total app-host traffic exclusion claimed while R1 is open.
- browser-html: When browser suites reload real stored state, source/version/comment/delete/automatic-view/data/store/conflict/Stop/restart flows bind the current viewer and accepted Stage 3/D44 audience with no Run/picker/consent gate; private-capable discovery including empty/unavailable responses and private code/data closes queued/future shared writes and settles submitted commits before private delivery, explicit shared-only discovery leaks no excluded totals, the locked instance's bridge cannot write private canaries/metadata/namespaces into shared storage/link projections for another viewer, intentional private-result file download works separately from ordinary person upload, member-equivalent agents receive no extra restrictions, and access/config/version/navigation lifecycle changes invalidate frames/ports/handles without leaking keys or disturbing preceding-stage selectors/viewers/controls/header/footer.
- client-html: When built CLI subprocess and stdio MCP suites run against local workerd, affiliated agents author/version/inspect inert embedded/attachment-backed HTML/applet source and inspect/edit stores via applet store show|put and applet_store_show/applet_store_put with explicit local inputs, current version/revision, the same store cap and exactly their member's D5 access; matching person/agent read-only, member downgrade/removal/expiry, epoch/rotation/stale/unknown/capability denials leave no private shared-endpoint metadata, execution, remote fetching, key output or approval/credential regressions, and encrypted exports preserve exact verified state.
- stage5-negative-controls: When the disposable mutation runner and extended AST boundary gate run, every named weakened audience/private-write-lock/store/member-access/identity/revision/version/epoch/rotation/source/payload/native-sandbox/CSP/bridge/parser/lifecycle/readiness guard reaches its designated assertion failure, including removal of allow-downloads and allowed native asset/framework/popup support; representative production Bend mutants fail both proof modes and duplicate/stub TypeScript decisions fail --rules, with boot/setup/syntax/missing-test failures and surviving mutants rejected rather than counted, operation-specific allowed/denied canary controls observed, a removed write lock demonstrably persisting private canaries, and no tracked production changes or mutant for a rejected interpreter/DOM/compute quota.
- stage5-regression: When the assembled Stage 5 tree runs after the last edit, all preceding-stage and new package typechecks/builds, core Node/workerd/browser, server workerd/R2, runtime native cross-browser isolation/allowed-output, web unit/end-to-end, built-client unit/integration, both proof modes, boundary modes, encrypted source/store/archive/private separation and all delivered preceding-stage plus Stage 5 negative controls pass with clean before/after diffs and guaranteed serial local-server cleanup; the next client version after the preceding stage/html-v1/full-capability boundary is aligned, histories are not purged, Q1–Q9 are recorded and implemented, R1 remains an explicit activation tripwire unless resolved, and no gate needs HOME/live services/deployment.

## Operator decisions (recorded 2026-09-03)

- **Scope:** every stage is in MVP scope. The numbered questions above are still open.

## Operator decisions, part 2 (recorded 2026-10-02; supersedes the recommendations above where they differ)

Dan: applets are risky and powerful by design. Don't restrict them below how pi-artifacts runs HTML artifacts.

- **Q1 runtime:** match pi-artifacts. Authored HTML/JS runs natively in the browser, in a sandboxed iframe with an opaque origin. pi-artifacts serves it with `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`, without `allow-same-origin`, and with a CSP of `default-src * data: blob:; script-src * 'unsafe-inline'; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors <app origin>`. Serve it from a separate origin from the app. Arbitrary frameworks work. Replace the QuickJS restricted interpreter: no virtual DOM and no guest interpreter.
- **Q2 data scope:** what the viewer can read in the containing journey (a). Data reaches the frame only through a parent postMessage bridge that checks the viewer's current access.
- **Q3 launch:** as in pi-artifacts, it runs when viewed. No Run button and no per-launch data picker.
- **Q4:** (a) accepted. Private applets keep only in-memory state.
- **Q5:** (a) accepted. After private data enters an instance, it can't write to the shared store. To move results out, the applet offers a file download, and the person adds that file to the journey as an ordinary artifact.
- **Q6:** the store is for members only. Agents get exactly the access of the member they are affiliated with: no extra rules and no extra limits.
- **Q7 links and downloads:** allowed. Links and popups open in new tabs, as in pi-artifacts (`allow-popups-to-escape-sandbox`). Downloads are allowed. Data an applet can see is treated as visible to the applet's audience. Still blocked: `connect-src 'none'`, form submission, top-level navigation, and the app origin.
- **Q8 limits:** none beyond pi-artifacts, apart from the existing 25,000,000-byte file limit and the store size limit the server already needs. Remove the interpreter memory, compute and DOM-node limits.
- **Q9:** agents do whatever their member can do, including inspecting and editing the store through the CLI and MCP. Neither the CLI nor MCP runs the applet.


## Technical-lead decision (recorded 2026-10-02, closes R1-app-origin-traffic)

- "The app origin" means no execution on the app origin and no authenticated access to it. Applets run on a separate origin that has no app cookies, tokens or storage, and with `connect-src 'none'`, so a request to the app host carries no credentials. Passive loads (an image URL, a popup to a public page) are allowed, as in pi-artifacts. Tests prove that no applet request reaches an authenticated app endpoint or reads app state. They don't need to prove that no byte ever reaches the app host.
