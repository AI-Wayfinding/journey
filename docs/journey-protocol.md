# Journey protocol v1

A **journey** is an encrypted team space. Its technical name in the package is **enclave**. This document covers the portable format; services and clients manage account sign-in, passkeys, caches, and delivery separately.

## Keys and records

Each person and agent has an X25519 age recipient. Agents can use non-extractable Web Crypto private keys; a person's exportable identity and Ed25519 signing key are encrypted with a key from one passkey outside this package. The passkey is also used for sign-in. A random 256-bit journey key belongs to a numbered **epoch** (one generation of the key). It is age-wrapped separately for every current member and agent. Removal creates the next epoch and gives wraps only to those who remain. Existing records stay under their old keys.

Every item is an append-only encrypted version. The plain envelope is `{ outside: { v:1, id, journey, seq?, epoch, size, createdAt }, nonce, ciphertext }`, with base64 nonce and ciphertext. The outside has no record type. The nonce is 96 random bits; AES-GCM authenticates the ciphertext and all outside fields. The service must allocate `seq` before sealing if it wants a sequence there. `size` is the unencrypted UTF-8 JSON byte length, not the ciphertext length. The inside is `{ type, typeVersion, body }`, including optional unknown fields. Unknown types and unknown values remain intact when records are read and saved; known breaking versions can upgrade on read through registered converters. This paragraph describes legacy records. Active signed-proof journeys refuse unsupported clients before reading or writing content.

Known inside types in version 1:

- `item`: `id, itemType, title, body, author, authoredBy, created, tags`, with optional `links: [{to,rel}]`, `replaces` (version identifier), `sharedFrom`, and `resourceKind`. Known item types include `position`, `interview`, `lesson`, and `resource`; new strings remain valid. `authoredBy` is `human`, `agent`, or `mixed`.
- `comment`: `id, item, onVersion, author, authoredBy, at, body`, with optional `inReplyTo`. Comments point to the version they discuss.
- `delete`: `target` records a deletion request. The service is responsible for deleting stored versions; a copy already held by someone cannot be erased remotely.

IDs are 26-character, time-sortable ULID-style strings from Web Crypto random bytes. Links and version identifiers use the same ID format. A search index is derived on a device and is not authoritative.

## A person's saved keys

On sign-up the service supplies a stable, random 32-byte PRF input for the account. WebAuthn PRF lets the person's passkey return a secret for that input when it is created. If PRF is enabled but the result is missing, the person sees an explanation before one extra passkey tap retrieves it from that same credential. If PRF is not enabled, sign-up stops; no credential or keys are saved. The client derives a 32-byte AES-GCM key from the PRF output with HKDF-SHA256 (`salt = UTF-8("wayfinding/person-keys/v1")`, `info = UTF-8("aes-gcm")`). This is a fixed, versioned HKDF domain: the account-specific random PRF input supplies account separation before derivation. Each private key is encrypted with its own random 12-byte nonce and authenticated data `wayfinding/person-keys/v1/identity` or `wayfinding/person-keys/v1/signing`. The saved JSON is `{version:1,identity,signing}`; both values are base64url of `nonce || ciphertext || tag`. The service stores only that ciphertext, not the PRF output or derived key. PRF byte arrays and derived bytes are wiped after use; the unlocked private keys remain in memory only until sign-out, tab close, or idle lock.

On a later visit, the service's login options include that account's PRF input. One WebAuthn assertion both signs in and returns the PRF output, so the client can fetch and unlock the saved keys without a second passkey tap. An already verified session can use the same one-tap request to unlock a new tab. Server schema version 4 rejects old sealed-key writes, hides old reads, and deletes the former two-passkey credentials and encrypted keys. Accounts from before this change must sign up again. Old journey keys are not converted; the migration assumes there are no real journeys yet.

## Signed membership history

Clients verify entries in memory. A service must store them encrypted if member identifiers and grants are to remain hidden from the server. Entries are `{ v:1, seq, prev, at, actor, type, body, sig }`; genesis has sequence zero and `prev:null`. `prev` is base64 SHA-256 of the previous complete signed entry. Ed25519 signs the entry without `sig`: sort every object's keys by JavaScript code-unit order, keep arrays in their original order, render compact JSON, then encode UTF-8. Strings are base64-encoded for signatures and hashes. Invalid chains, signatures, or permissions stop verification at the failing sequence. New, unknown entry types stop with `client-too-old`; they are never ignored.

- `genesis` names the journey, its creator's public recipient and signing key, grants `members.manage` to that person, and records `mode:sealed`, `visibility:private`, and `minClientVersion`. The first key epoch is 1.
- `member.add` contains a member, their grants, and their kind. A person with `members.manage` adds people. Any person may add their own agent. An agent has `addedBy`, `scope:read|readwrite`, and optional `expiresAt`, and gets no management grant.
- `member.remove` names a member. A holder may remove any member; a person may remove themselves or their own agent. Removing a person always removes their agents as well. An agent cannot sign a membership change.
- `grant.add` and `grant.remove` change `members.manage` for people only. After **every** entry, at least one person must still hold it. A holder signs grant changes.
- `key.rotate` names the next epoch and a SHA-256 hash of a canonical, ID-sorted list of all remaining `[member ID, age recipient]` pairs. Only a holder signs. It does not itself carry the wrapped keys; clients must check the supplied wraps against the verified member list.
- `client.minVersion` raises or retains the minimum compatible client version. Versions are three dot-separated nonnegative integers, compared numerically. A holder signs it.

### Stage 0 controls

Content role (`read-only` or `read-write`) and guide authority (`members.manage`) are separate. A person guide of either role manages settings, person roles, guide grants and rotation. Guide authority never grants content writes. Agents cannot be guides; their current access is their adding person's current access limited by the agent's original `scope`. Missing, removed or expired adding people give their agents no live access. Agent links remain read-only.

- `journey.settings` contains `name`, `description`, `defaultRole`, `visibility` and `joiningPolicy`. A guide signs it. The default role applies to later normal person admissions, not existing members. Temporary support admissions remain read-only with their original expiry and cannot become guides or change role.
- `member.role` contains a person's `member` ID and `role`. A guide signs it. It changes that person's current role, which changes their agents' effective access without changing the agents' original limits.
- `member.profile` contains the acting person's `id`, `name` and optional `email`. Only that person signs it, even if someone else is a guide. Existing journey email opt-in remains private.
- `member.rename` contains an agent's `id` and `name`. Its adding person or a guide signs it.
- `member.renew` contains an agent's `id` and `expiresAt`. Its adding person signs it. It changes expiry without remove/re-add or a wider original limit.

Settings retain `visibility:private` independently of `mode:sealed`. Creation stays private. `joiningPolicy` represents `invitation-only`, `guide-approved` and `immediate`, but only `invitation-only` can be used in Stage 0. Visibility conversion, public creation/listing, and activation or key delivery for the other policies are later-stage work. No picture or public attribution fields are added here.

### One signed control, encrypted labels

New controls use `ControlProof`: `{v:1,journey,seq,prev,at,actor,type,body,envelopeHash,sig}`. This signed public record is the **only action**. The server and keyed readers apply its type, actor, position and public body. The public body copies the control's defined fields, replacing private `name`, `description`, `email` and nested member `name` with base64 SHA-256 of their canonical JSON values. Other fields retain their public values. The proof therefore exposes the same authority fields as the verified projection, never private labels or ordinary content.

The encrypted record is only `{type:'control.labels',typeVersion:1,body:{name?,description?,email?,memberName?}}`. It has no action, actor, grants or role. `sealControlLabels` copies only these labels. Readers reject any other payload shape or action fields; they never interpret an encrypted `LogEntry` as a second control. A hostile signer may encrypt arbitrary bytes, but these bytes cannot authorize anything.

`envelopeHash` is base64 SHA-256 of canonical JSON for the exact complete envelope, including outside fields, nonce and ciphertext. The proof signature uses the same canonical JSON and Ed25519 procedure as legacy entries, omitting only `sig`. The creation proof starts at sequence zero with `prev:null`. Later sequence numbers continue the signed proof log, and `prev` is the hash of the previous complete proof. The envelope's journey and sequence must match the proof. Changing ciphertext, actor, journey, public body or position invalidates verification.

`verifyControlProofs` verifies chain, pinned creation identity, public field shapes and signatures before sending the action to compiled Bend rules. The creator's signed creation proof pins the creator. The server calls `verifyControlProofs` without legacy history; caller-supplied history and plain access rows cannot initialize trust.

Keyed readers reconstruct display fields with `readControlProof` only after proof verification. Each decrypted label must match its public digest. A missing key, malformed label payload or wrong digest makes the label `[unavailable]`, with its field listed in `unavailableLabels`. The signed action still applies. Labels never decide permissions. Public replay also uses unavailable labels, not digest strings presented as names or emails. The reconstructed entry's `sig` belongs to the public proof, not to an independent legacy `LogEntry`; do not pass reconstructed entries to `verifyLog`.

### Legacy upgrade

Existing journeys were test data and are purged on the schema upgrade, not migrated. Enclave schema version 2 deletes legacy logs, record envelopes, key and recovery wraps, access rows, reservations and journey metadata. Registry journey metadata, account-to-journey links, invitations, pending admissions and agent links are also deleted. Accounts, credentials, sessions and agent registrations are kept. No migration checkpoint is built, and the server refuses creator-submitted legacy history and the old opaque log write format.

New journeys begin with a signed creation proof and minimum client version `0.1.5` for Stage 1. Stage 0 regression histories may still use `0.1.4`. The minimum cannot decrease. Clients at `0.1.3` or older, or callers lacking `control-proof-v1` capability, are refused before reading content or submitting controls. The authenticated `/v1/journeys/:id/protocol` route returns the required version and format without content. Capability claims never replace signatures or current authority checks.

Visibility changes, projects, artifact migration, private interview access and public joining can add their own record/version boundaries in later stages; Stage 0 adds no unused implementations for them. Unknown membership controls must still stop verification, never be ignored.

## Stage 1 artifacts

Stage 1 contracts are in `packages/core/src/artifacts.ts`; portable binary crypto is in `packages/core/src/blobs.ts`. The server provides authenticated local/production R2 transport and the browser and CLI/MCP implement artifact and attachment workflows. These artifacts are journey-visible, not author-private. Reserved types `html`, `applet`, `interview`, `sensemaking-document` and internal `recovery` are not active artifact types.

### Signed actions and identity

Artifact actions continue the existing `ControlProof` chain. Control sequence numbers are separate from ordinary `/records` reservations. All public bodies have exactly `format:'artifact-v1'`, stable `artifact`, immutable `author` and actual signer `actor`. Each action adds only these fields:

| Action | Additional public fields |
| --- | --- |
| `artifact.create` | fresh `version`, `typeHash`, `blobs` |
| `artifact.version` | fresh `version`, current `predecessor`, original `typeHash`, `blobs` |
| `artifact.comment` | fresh `comment`, optional `onVersion` |
| `artifact.delete` | none |

Artifact, version and comment IDs use the existing ULID format and cannot reuse an earlier artifact/version/comment ID. The stable artifact ID never changes. `typeHash` is base64 SHA-256 of canonical JSON for the active type string. It pins the type without a plaintext type field. It is a commitment, not secrecy: the small type vocabulary can be enumerated. `blobs` is an ordered array of complete descriptors defined below, not arbitrary bucket keys. Unknown fields and unsupported type commitments are refused.

The first signer is the immutable author. Every version, comment and deletion names that author and separately names its real signer. Production Bend functions decide current inherited write access, the Stage 1 minimum, attribution, freshness, predecessors and references. Any current read-write person or agent may edit/comment/delete; guide authority adds no content permission. Agents still cannot sign person or guide controls. Replay checks access at the signed entry time; the server must also recheck current access at commit. A stale predecessor conflicts. Comments belong to the whole stable artifact, with an optional version ID for context, never a selected passage. Deletion is irreversible in Stage 1 and hides all versions/comments/attachments from ordinary views. Signed and encrypted metadata history stays for integrity and export, not secure erasure.

A hostile caller must not forge an author/writer, gain content writes from guide authority, widen an agent's inherited limit, reuse IDs, resurrect deletion, reuse a different artifact's blob, or write after downgrade/removal/expiry/pending rotation. TypeScript validates signatures, formats, journey/epoch bindings and exact descriptors, then adapts named fields into Bend. Blob staging ownership/completion and current transport capability checks are storage-node responsibilities; a signed descriptor alone proves neither an upload nor read access.

### Encrypted content

Artifact ciphertext uses the existing AES-GCM envelope and exact `envelopeHash` binding. Its inside record is one of:

- Create/version: `{type:'artifact.content',typeVersion:1,body:{title,tags,content,attachments}}`.
- Comment: `{type:'artifact.comment-content',typeVersion:1,body:{text}}`.
- Delete: `{type:'artifact.tombstone',typeVersion:1,body:{}}`.

The complete decrypted record is at most 1,048,576 UTF-8 JSON bytes. Unknown fields are refused at every artifact level. `title` and comment `text` are strings. Tags are case-preserving strings, unique by exact value; suggested tags are not types or permissions. Content has exactly the fields in this table:

| `content.kind` | Content fields |
| --- | --- |
| `skill` | required nonempty `skill` text representing `SKILL.md` |
| `prompt` | required nonempty `text` |
| `document` | `markdown` text |
| `image`, `file` | `primary`, the ID of exactly one selected attachment |
| `data` | `format:json\|csv\|toml\|yaml\|sqlite`, and exactly one of `text` or `primary`; SQLite requires an attachment |
| `link` | absolute `http:` or `https:` `url`, supplied `summary` and `notes` |

Attachments are `{blob,name,mime,path?}`. Each version allows at most eight distinct blob IDs. Names and MIME strings stay encrypted and do not authorize inline rendering. Package paths are relative display paths of at most 255 characters; empty components, `.`/`..`, backslashes, colons and control characters are refused. Skill attachments require paths, unique by exact value, and cannot replace `SKILL.md`. No archive extraction, dependency execution or remote fetching is part of the contract. URL credentials, whitespace/control characters, relative URLs and non-web schemes are refused. Validation never fetches a URL. The browser keeps links inert until deliberately opened and does not load remote images or execute Markdown HTML.

Keyed readers verify the encrypted content's type commitment and attachment descriptor list against the public proof. Content is never interpreted as actions, actor or grants. Public replay cannot inspect private content; keyed replay rejects malformed artifact payloads. Existing controls still accept only `control.labels`; artifact content does not weaken that rule. `readArtifactPayload` is a content decoder and must be called only after verifying the proof chain.

### Blob descriptor and binary crypto

A descriptor is exactly `{v:1,journey,id,epoch,size,ciphertextSize,nonce,digest}`. Epochs start at 1. Raw `size` is an integer from zero through 25,000,000 inclusive. `ciphertextSize` is exactly `size + 16`. `nonce` is canonical base64 for 12 random bytes; `digest` is canonical base64 SHA-256 of the binary ciphertext including the AES-GCM tag.

Binary blob encryption uses the journey epoch's 256-bit AES-GCM key and a fresh nonce. Associated data is UTF-8 canonical JSON for `{v:1,journey,id,epoch,size}`. Nonce travels in the descriptor, not prepended to the stored bytes. `sealBlob` and `openBlob` implement binary encryption/decryption; R2 stores those binary bytes, not base64 or data URLs. Base64 is used only when embedding bytes in the encrypted JSON archive. Readers verify digest, lengths and authenticated metadata. The 25,000,000-byte binary limit does not widen the JSON cap.

A later version may reuse an identical committed descriptor from an undeleted version of the same artifact. Descriptors cannot change after an ID is referenced. Cross-artifact references, including references previously used by a deleted artifact, conflict. All versions of an undeleted artifact retain live references, even attachments absent from the current head. Whole-artifact deletion ends those live references; cleanup must never remove a live reference. New staged blobs remain subject to uploader ownership, completion, current epoch and current-write checks in storage.

### New-input mapping and compatibility

`suggestedArtifact` maps `note`, `decision`, `question`, `learning`, `tension`, `practice`, `success`, `resource`, `position`, `interview` and `lesson` to `document` plus that same suggested tag. Other strings also map to `document` plus the original tag. Supplied tags are retained and exactly deduplicated. `recovery` returns no artifact and must not appear in artifact views/counts/searches/links. This helper handles only new create/import inputs. It performs no historical migration, rewrite or trust bootstrap.

Stage 1 uses client/interface version `0.1.5` and both capabilities `control-proof-v1` and `artifact-v1` (`X-Control-Format` and `X-Artifact-Format` headers). `supportsArtifacts` refuses old/malformed versions, missing capabilities and a newer signed minimum. New journeys require Stage 1; Stage 0 fixtures can raise their signed minimum before the first artifact action. Consumers must fail with an update message before partial content, not skip unknown actions. Live agent links remain deliberately server-readable, read-only and limited to their existing overview; attachment access requires the member interface.

### Stage 2 signed project contracts

Core/client/interface version `0.1.6` adds `project-v1` alongside `control-proof-v1` and `artifact-v1`. Request adapters send `X-Project-Format`; subjects and protocol-response readers carry `projectFormat` by name. `supportsProjects` checks the signed minimum and all three capabilities through Bend. A person guide must raise an existing journey's signed minimum to at least `0.1.6` before a project action. Histories at `0.1.4` or `0.1.5` remain valid with empty project indexes; `artifact-v1` still begins at `0.1.5`. A keyed reader rejects a minimum newer than its supported version rather than returning partial content. The server applies this requirement consistently to journey list/access, controls, log/records/wraps, reservations, blob staging/upload/download and exports. Authenticated `GET /v1/journeys/:id/protocol` remains content-free for old callers and reports `projectFormat:'project-v1'` at this minimum. Incompatible callers receive 426 before any content; minimum-raising controls must themselves meet the resulting minimum and capabilities.

The public chain adds these exact bodies (every body includes `format:'project-v1'`):

| Action | Other public fields |
| --- | --- |
| `project.create` | `project`, `purposeHash`, `state:'getting-started'` |
| `project.purpose` | `project`, `purposeHash`, `predecessor` |
| `project.state` | `project`, `state`, `predecessor` |
| `project.join`, `project.leave` | `project`, `member`, `predecessor` |
| `artifact.project` | `project` (ID or null), `artifact`, `author`, `actor`, `predecessor` |

Project IDs are journey-scoped ULIDs and cannot reuse project, artifact, version or comment IDs. Purpose/state share a revision: the latest creation/purpose/state proof sequence. Participation revisions belong to each project/person pair; placement revisions belong to each artifact. `predecessor` is that observed sequence, or null for an absent pair/pointer. It must precede the new proof. Stale or no-op membership/state/placement changes conflict. State values are exactly `getting-started`, `active`, `looking-for-others` and `archived`; participants may choose any different value. Archive remains readable and can reopen; there is no delete control.

Purpose is trimmed, nonempty plain text of at most 10,000 UTF-8 bytes. `purposeHash` is canonical base64 SHA-256 of the canonical JSON string, not plaintext or protection against guessing short purposes. Create/purpose encrypt exactly `{type:'project.content',typeVersion:1,body:{purpose}}`; other actions encrypt `{type:'project.marker',typeVersion:1,body:{}}`. The existing JSON cap, exact public shape, envelope/signature/epoch bindings and purpose commitment are checked before keyed content is returned. Missing project keys and payload extras fail. Public replay displays `[unavailable]` purpose text. Ciphertext cannot grant authority or supply another action.

Production Bend decides creation/placement content authority, self-only live person participation, agents following their live adding person, removal invalidation, participant metadata authority, revisions and selectors. Creation does not join its signer. Read-only participants may edit purpose/state (D17), but cannot create/edit/comment/delete/place artifacts or stage blobs (D5). Pending rotation blocks those content writes, not authorized participation/metadata controls. Removing a person deactivates their pairs; readmission requires a fresh join. Agents never store independent participation. Guide status alone grants no metadata or content write.

`artifact.project` changes one nullable pointer on an undeleted artifact, validating immutable author, actual signer and a project in that journey. It does not change content versions, comments, author or blob references. `selectProjectArtifacts` returns undeleted unassigned IDs for omitted/`main`, one project's IDs for a project ULID, or every undeleted artifact for `all`, including archived placements. Unknown/malformed selectors fail; callers intersect existing type/tag/text filters with the result. Project placement never changes journey read permission, export or deletion accounting.

Server project commits append to the existing serialized signed log, atomically updating proof, verified projection and chain head. Live Bend authorization is checked again immediately before commit. Exact committed-proof retries are idempotent (200, `retry:true`); changed/stale proofs return 409. Rejected requests cannot change authority or blob references.

Read-only `GET /a/:secret` accepts `project=main` (also omitted), `project=<ULID>` or `project=all`. The verified selector controls artifacts, not read access. Response `projects` rows carry purpose/state/revision and effective participants; purpose fragments and separate participant-roster chunks carry `part:{number,of}` and the project ID. Concatenate those fields in page order. Project data is not an unbounded header. Actual UTF-8 JSON pages remain within 12,000 bytes without splitting Unicode characters, and `page.next` preserves the selector. Malformed selectors return 400, unknown/foreign projects 404. Existing live expiry/revocation, no-store, recovery/deletion exclusions and no write/download/search/show routes remain.
The `artifact-v1`/version-1 archive container and APIs are unchanged. Named-field projection retains all project controls and payloads; verified replay rebuilds project history, participation and placement. An archive cannot supply its own project index. Portable Node/workerd/browser tests exercise the production decisions; Node archive tests encrypt and import actual project history with live blob bytes. Bend proofs cover these production functions, not cryptographic certification.

### Versioned encrypted archives

`exportArtifactJourney` and `importArtifactJourney` use one age-encrypted JSON object:

```text
{format:'artifact-v1', version:1, journey, creator,
 controls:[{proof,envelope}], envelopes, wraps,
 blobs:[{descriptor,ciphertext}], unavailableDeletedBlobs:[blobId]}
```

`controls` retains the exact signed public chain and encrypted payloads, including tombstoned metadata. `envelopes` carries separate internal/ordinary records, not a second action chain. `wraps` uses existing `{epoch,recipient,ciphertext}` key wraps. `blobs` contains canonical base64 ciphertext for every referenced blob in every undeleted version, exactly once. `unavailableDeletedBlobs` names the distinct historical references no longer live; deleted blob bytes are not exported.

Import and export both verify the archive against separately pinned `{journey,creator}`, public signatures and the full chain before returning content. All control keys must be available, keyed payloads must match their public projections, and blob digests, lengths, AES-GCM metadata and surviving references must verify. Missing live bytes, unreferenced bytes, duplicate IDs and unexpected fields fail. Only named fields survive output. Archive format/version mismatches are refused; legacy `importJourney` is separate and is not a Stage 1 migration path. A complete valid earlier chain is still a possible rollback without an external checkpoint. Downloaded archives, keys and content cannot be recalled.

The Bend proofs cover symbolic authority and reference transitions in production functions. They do not claim cryptographic certification. Local workerd/R2 tests exercise atomic commits and export, and browser tests separately exercise rendering safety.

### Local integration checks

Build rules and core before consuming them; build the client before tests that execute its CLI/MCP. Run suites serially, especially browser and client integration tests sharing port 18787. Test configs use local R2 and do not require HOME, live services or deployment. Builds write ignored outputs; evidence must not change tracked files.

`node scripts/check-bend-boundary.mjs --rules` parses TypeScript expressions and required call sites. It rejects duplicated role, attribution, predecessor/reference authority and stubbed artifact adapters while retaining the Stage 0 checks. Project checks also reject host participation/inheritance filters, state/placement decisions and client-minimum comparisons. Only exact format, display and named-field adapters are exempt; replay and participant/selector returns must use the real Bend result. `--build` checks shared dependency/build ordering and `--guidance` checks the existing Bend instructions.

`node scripts/check-stage1-negative-controls.mjs` copies tracked source into disposable ignored `.scratch/` trees, uses read-only dependency links, builds separate rules/core outputs and runs one named test per mutation. A mutation is a deliberately weakened production guard. The runner first demands passing baselines, then assertion failures for public signature/ciphertext binding, private-action rejection, creator/writer attribution, stale predecessors, cross-artifact references, inherited write access/minimums, upload ownership/completion/current access, deleted downloads/live-reference collection, byte limits/digests, URL validation and safe rendering. Bend mutations must also reject the actual production proofs in both modes. Boundary probes inject duplicated TypeScript decisions and replace an adapter with a stub. Missing tests, setup failures and surviving mutations cannot count as success; harness controls exercise all three cases. The runner deletes its disposable trees on success or failure and checks the tracked diff remains unchanged.

`node scripts/check-stage2-negative-controls.mjs` uses the same disposable-tree approach for self-only participation, inherited live participation and removal invalidation, D17 metadata/content separation (including blob staging), creation/state, stale revisions, same-journey placement and deleted references, main filtering, versions/capabilities, unknown controls, ciphertext commitments/extra fields, atomic projection storage and read-only link routes/selectors/pagination. It reports each named assertion failure and both proof failures for representative Bend mutations. Duplicate TypeScript branches/filters and stubbed project replay must fail `--rules`; missing tests, setup failures and surviving mutations fail the runner. Production files remain unchanged.

Stage 2 regression adds core project/archive tests in all three runtimes, server project/link tests, browser project workflows and real CLI/stdio MCP tests. The server link test compares main/project/all IDs with keyed replay and an encrypted member export, retaining archived attachments for a nonparticipant. Run both Stage 1 and Stage 2 negative controls to preserve earlier guards.

Full Stage 1 regression includes package typechecks/builds, both Bend proof modes, Node/workerd/browser core suites, server workerd/R2, web unit/end-to-end and built-client unit/integration suites, followed by the focused Stage 1 suites and negative controls. `packages/server/test/stage1-storage.test.ts` round-trips a server archive with another writer, comments, historic live attachments and tombstoned metadata. `packages/server/test/stage1-link.test.ts` reloads the read-only paged overview, checks real writer attribution and newer-minimum refusal, and excludes deleted/recovery content and attachment download routes.

## Stage 3 private contracts

Core/client/interface `0.1.7` adds `private-v1` and `X-Private-Format` alongside the three earlier capabilities. At this signed minimum, the server requires all four on shared and dedicated content routes and on minimum-raising controls; content-free `/protocol` negotiation still works for incompatible current members. `supportsPrivate` calls Bend to check all four formats and the signed minimum. Private writes require a signed minimum of at least `0.1.7`; `0.1.4`–`0.1.6` histories remain valid. A future `0.1.8` minimum fails before private views are returned. Capability claims do not grant keys or access. These portable contracts do not implement vault transport, durable storage, browser workflows or CLI/MCP commands; those adapters must enforce the same rules before committing.

### Separate signed history and audience

`packages/core/src/private.ts` defines records entirely inside private encryption, never public `ControlProof`:

```text
{format:'private-v1',v:1,id,vault,copy,seq,prev,at,actor,authority,type,body,payloadHash,sig}
```

Vault, copy and stable artifact IDs are random 256-bit base64url values, without time bits. Record, version and comment IDs use ULIDs. `seq` counts records within one copy, starting at zero; `prev` hashes the complete previous signed record. Ed25519 signs canonical JSON omitting only `sig`. `payloadHash` commits to the exact decrypted content/comment/marker. Every body includes `artifact`, immutable `author` and actual `actor`. The exact additional fields are:

| Action | Additional encrypted fields |
| --- | --- |
| `private.create`, `private.version` | `version`, `typeHash`, `blobs`, `predecessor` (null at creation) |
| `private.comment` | `comment`, optional `onVersion` |
| `private.delete` | current content `predecessor` |
| `private.project` | nullable `project`, placement `predecessor` (null initially) |
| `private.copy` | `version`, `typeHash`, `blobs`, `predecessor:null`, `origin`, `destination`, `snapshotHash` |

Author/actor identities are exactly `{kind,signingKey,recipient}`. `authority` is `{journey,principal,admissionHash,head,epoch}`, binding both keys and member kind to independently verified genesis/member.add history and the cited current public head. Display names, account IDs and matching principal strings cannot establish identity. Opaque contexts, sessions and views are held in private WeakMaps: caller-created objects or imported indexes cannot substitute for verification. Detached named-field outputs prevent later mutation from changing accepted state.

A person author's audience is that person plus live authenticated agents added by that person in the containing journey. An agent author keeps its own identity; its adding person does not gain access to its private content. Bend derives audience, inherited read/write limits, expiry/removal, pending-rotation denial and current-snapshot write authority. Guide status, project participation, direct recipients and link credentials grant nothing. Sessions require both admitted Ed25519 and age private-key possession. First handoff uses a one-use local 32-byte challenge, signed over the complete author/admission/recipient binding and opened with the admitted age key. A missing or unknown credential class fails closed. Offline historical verification is read-only and cannot authorize new proposals or handoffs.

Production Bend checks immutable author/actual actor, content type, sequence/predecessor, fresh references, irreversible deletion and zero-or-one same-journey project placement. Stage 2 projects supply the verified project state and main/project/all selectors; participation never elevates private access. Private payloads reuse strict Stage 1 content syntax, limits and safe paths. Unknown fields/actions, grants, bad signatures/hashes and stale/deleted references fail without a partial view. Public replay rejects private actions, and shared archives keep their existing exact format with no private fields.

### Private copies, attachments and encrypted bundles

A private copy begins a new chain in a different journey with a fresh copy key and independent later versions, comments, deletion and placement. Its origin is `{journey,copy,artifact,version,recordHash}`; destination is `{journey,copy}`. `snapshotHash` binds the source current logical content and raw attachment hashes, independent of destination ciphertext handles. Source and destination both require current ordinary write access and the Stage 3 minimum. Both destination visibility models use the same private audience; these models do not enable public creation/join/read routes. Origin never enters public output.

A private attachment descriptor is exactly `{v:1,vault,copy,id,generation,size,ciphertextSize,nonce,digest,contentHash}`. It remains inside encryption. Size limits match Stage 1; ciphertext size is raw size plus the 16-byte AES-GCM tag. `digest` hashes ciphertext and `contentHash` hashes raw bytes. HKDF-SHA256 derives history/blob keys from the 32-byte copy key with salt `wayfinding/private/v1` and canonical info `{purpose,vault,copy}`. Blob AAD is canonical `{format:'private-v1',v:1,vault,copy,id,generation,size}`. Copies re-encrypt attachments under fresh destination IDs/nonces, never reuse shared journey keys or source ciphertext.

`packages/core/src/private-transfer.ts` verifies one separate age-encrypted bundle:

```text
{format:'private-v1',version:1,vault,author,scope,authorityHistories,
 records,payloads,copyKeys:[{copy,key}],
 blobs:[{descriptor,ciphertext}],unavailableDeletedBlobs}
```

Scopes are `author-backup`, `agent-handoff` and `agent-return`. Bend selects the single derived recipient; live audience checks still apply to every copy. No root/index key, arbitrary recipients, grants or caller index is accepted. Verification checks complete signed copy histories and independent membership histories, exact descriptors, authenticated decrypted bytes and every live reference before returning named fields. Historical recovery is author-backup only. Deleted histories remain verifiable while their unavailable bytes are listed; other copies remain independent. Bundle verification does not itself commit a vault or replace a checkpoint.

### Fixed slots, scheduled patches and retained checkpoints

The fixed container contract is 64 slots of 1,048,576 ciphertext bytes, allocated in full for every person member at join, including empty vaults. Agents have no vault of their own and admission allocates no vault storage; authenticated agents use their adding person's vault. Foreign agents and link credentials cannot access it. It never grows. Capacity refusal must leave storage unchanged. On journey open and every 300,000 ms while open, adapters read a signed header plus two slots and upload exactly two re-encrypted slots plus the next signed header, including dummy commits when nothing changed. Dirty slots go first, otherwise random slots; saves wait for the next sync and cannot trigger traffic. A whole-container fetch occurs only when there is no retained encrypted cache. Browser/Node adapters retain that cache across open lifetimes and test matched empty/populated request shapes and virtual-clock traces.

A header is exactly `{format:'private-v1',v:1,vault,author,version,prev,contentsHash,slots,sig}`, with 64 slot digests and a complete-contents digest. An atomic patch is `{format:'private-v1',v:1,vault,token,header,slots:[{index,ciphertext},{index,ciphertext}]}` with distinct valid slot indexes. The token is an opaque compare-and-swap token, not freshness authority. Header versions count scheduled commits, never private operations. Cryptographic adapters verify signatures, pinned identity and slot/contents digests. The signed `prev` is null at version 1 and the immediate predecessor digest thereafter. No ancestry chain is transported: a valid member signature authorizes skipped versions above a retained checkpoint. Bend decides accepted freshness, rollback, conflict and merge.

An agent-signed header adds exactly `writer` (the agent's own identity) and `authority` (its verified journey/admission binding). The agent signs with its own Ed25519 key, never the person's key. Verification replays the person's verified control log through `authority.head` and requires unexpired membership added by this vault's person and inherited write access at that position's signed time, with matching admission and epoch. Positions before admission, after removal or outside the verified log cannot authorize a head; foreign, read-only and link agents gain no authority. Later expiry or removal does not invalidate an already accepted head or lock the person out. The server still requires current eligibility for every agent PUT; the person's next commit signs the head normally. Person and agent commits share the same monotonic version/checkpoint. Only the person can initialise the vault; neither agent headers nor requests can change its pinned vault ID or owner.

The person's device creates a separate age content identity inside the encrypted frame. Frames are encrypted to both the person's existing recipient and this content recipient; slot root keys remain inside the frame. Existing person-only frames migrate on the next scheduled commit. For each eligible agent, the person's device signs a `wayfinding/private/agent-wrap/v1` message containing this content identity and the exact journey/person/agent/vault/author/recipient binding, then age-encrypts it to that agent's recipient. The person's identity and private signing keys are never delegated. Browser approval creates the wrap, and journey opening backfills approved authenticated agents. Node person adapters use `openPersonPrivateVault` at approval/open; agents fetch their own wrap and `JourneyClient.openPrivateVault()` decrypts the person's existing vault.

The dedicated vault store keeps each wrap as ciphertext. Server vault operations serialize the live membership check with opaque storage access. An agent session is bound to its registered journey; only recognized authenticated registration classes may access private transport. Eligible read-only agents may read the person's vault and their own wrap, but every vault PUT is refused. Unknown private fields are refused at shared log/record/wrap/blob boundaries rather than accepted as a private storage extension. Only that authenticated agent can fetch it; persons can deliver only to their own eligible agents. Links, guides acting for another person, and foreign agents receive no wrap. Removal deletes the wrap, and expiry removes it through a store alarm; current server membership denies further access. Vault content keys do not currently rotate on removal. Revocation stops future server access, not access to ciphertext or keys already downloaded; it cannot recall private copies.

Retain the highest verified checkpoint separately from replaceable cache bytes. `VaultOptions.paired` accepts a trusted checkpoint from a paired device. There is no pairing workflow or UI yet; callers must obtain that trusted input out of band. Without it, a signature-verified server head remains explicitly `unverified`, including repeated reads. Lower versions cannot replace retained checkpoints. Independently verified same-version heads with different digests require per-copy merging: higher content version wins, ties retain both branches, and a tombstone beats a live branch. Both histories must be independently verified before merge; adapters must sign the merged container at a higher version. Corrupt/unsigned forks, invalid predecessor framing and bad digests fail. Backup import cannot reset a retained checkpoint. Deleting all local state removes its rollback protection; a caller must restore its trusted checkpoint, never infer freshness from the server.

`PrivateVaultObject` uses a dedicated SQLite Durable Object addressed only by the authenticated journey/member mapping, never a caller-supplied vault handle or shared R2 path. Every successful person admission provisions all 64 slots before acknowledgement. Agent requests resolve to the adding person's vault only after the verified private-audience check; the caller cannot select another vault. GET carries a 64-byte random compare-and-swap token, a one-byte initialization marker, a 32 KiB encrypted header frame and fixed-size indexed slots. PUT carries the same token plus exactly the encrypted frame and two distinct slots; SQLite replaces them atomically. The initialization marker describes whether this member has opened the journey, not whether it has private content. Header plaintext is padded before age encryption so the embedded ciphertext length also stays fixed.

The controller stages verified complete bundles using copy-on-write chunks. Old live branches remain referenced until every replacement chunk is uploaded. Unmatched cached slots are unavailable, never decrypted or rendered; the signed checkpoint advances even if a later upload fails. The next scheduled tick fetches missing chunks before rendering. Cache adapters reject rollback and concurrent checkpoint replacement. IndexedDB stores ciphertext and an independently encrypted checkpoint in one transaction; Node writes an immutable encrypted cache plus an independently encrypted checkpoint pointer, fsyncs, then renames the pointer. Cleanup under the commit lock preserves live references. Lock/sign-out closes controllers, cancels scheduled work and discards decoded history and pending bytes. The browser opens the adapter for every journey context, including empty vaults; Node exposes an explicit `JourneyClient.openPrivateVault()` lifetime and `close()`.

The Stage 3 suites exercise these contracts in Node, workerd and Chromium, plus encrypted bundle/cache round-trips. Bend proofs cover production decisions, not cryptographic certification.

## Removal and export

`removeAndRotate` produces legacy signed removal and next-epoch entries, a fresh key, and one age wrap per remaining member and agent when a remaining guide performs both operations. It refuses self-removal because that person could not sign rotation. `removeMemberEntry` lets a person of either role sign their own leave or removal of their own agent, and lets a guide remove another member. Removal cascades to a person's agents and cannot remove the last person guide. `completeRotation` lets a remaining guide of either role finish delivery. Personal removal authority never grants rotation authority. These helpers produce legacy entries; proof-based callers use the same verified state and effects, but seal only labels and sign `ControlProof` for each action.

For upgraded journeys, removal makes rotation pending: content writes and sequence reservations must stop, while authorized controls, including guide-only rotation, remain possible. Removal and rotation cannot recall already downloaded keys or copies; future records and keys go only to survivors. Helpers cannot atomically deliver changes or enforce server access by themselves.

An export is one age-encrypted JSON file with `log`, `envelopes`, and `wraps`. `importJourney` verifies membership signatures, the chain, and each envelope it can decrypt before returning the archive. Keep historic wraps if historic records must remain readable. An archive and the server can still withhold records or present a prior valid history; retain a separate checkpoint if detecting rollback matters.

## M2 service wire formats

The Worker API lives under `/v1`. Clients generate a journey ID with `newId` before encrypting genesis, then send that `id` when creating the journey. A record's `outside.seq` is authenticated by core, so the client calls `POST /v1/journeys/:id/seq` before sealing and sending `POST /v1/journeys/:id/records`. The server returns `{seq,epoch}`; a five-minute reservation is bound to the authenticated principal. A write under an old epoch returns `old-epoch` and the client must fetch current wraps. Each record is at most 1 MiB of plaintext. The client verifies all signed entries, not the server.

The following is the historical M2 wire format, now refused by the server, not the Stage 0 authority contract. Stage 0 service/client adapters must use the verified public control above and derive access effects from it, never trust plain row instructions.

A legacy log request contains `entry`, the base64url encoding of a JSON core envelope whose encrypted body contains the signed `LogEntry`. The server assigns an outer log sequence and stores only the opaque bytes. `accessChanges` is a plain server access-list instruction containing `{principal,action:'add'|'remove',kind:'person'|'agent',scope:'read'|'readwrite',expiresAt?}`. It does **not** carry a signed grant. `memberWraps` supplies `{principal,epoch,wrap}` for additions to the current epoch; a rotation uses `epoch` and `wraps` for the next epoch. The client posts removal and rotation as separate signed entries. The object blocks new writes between removal and rotation. On rotation, every new wrap belongs to a non-removed principal. The device checks that this set matches its verified log.

An invite uses 32 random bytes placed after `#` in the link. Only the base64url SHA-256 digest is posted as `inviteIdHash`. The invitee sends the random preimage as `inviteId` to `/v1/invites/accept` after email and passkey verification, together with their new principal ID and public keys. The server consumes the invite once and stores a pending principal without the invitee's plain email. A holder's device reads `/v1/journeys/:id/invites/pending`, verifies the signed log, signs and encrypts `member.add`, and posts it with the access addition and `memberWraps`. An invite does not itself grant read access. An optional `inviteSecretProof` field is reserved for a later proof scheme; M2 checks the random preimage against its digest.

An approved agent signs each journey request with its Ed25519 signing key. The four headers are `X-Agent-Session` (opaque session ID), `X-Agent-Timestamp` (Unix milliseconds), `X-Agent-Nonce` (fresh string), and `X-Agent-Signature` (base64url). The signature covers UTF-8 of `METHOD\nPATH_WITH_QUERY\nBASE64URL_SHA256_EXACT_BODY_BYTES\nTIMESTAMP\nNONCE` without a final newline. `METHOD` is uppercase; `PATH_WITH_QUERY` starts with `/` and includes the raw query string but no host; an empty GET body hashes as empty bytes. The server rejects requests more than 60 seconds from its clock and stores used nonces to prevent replay. Agents do not get a browser session cookie.
