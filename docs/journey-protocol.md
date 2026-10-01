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

Stage 1 contracts are in `packages/core/src/artifacts.ts`. Storage and interface nodes implement their delivery separately. These artifacts are journey-visible, not author-private. Reserved types `html`, `applet`, `interview`, `sensemaking-document` and internal `recovery` are not active artifact types.

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

Attachments are `{blob,name,mime,path?}`. Each version allows at most eight distinct blob IDs. Names and MIME strings stay encrypted and do not authorize inline rendering. Package paths are relative display paths of at most 255 characters; empty components, `.`/`..`, backslashes, colons and control characters are refused. Skill attachments require paths, unique by exact value, and cannot replace `SKILL.md`. No archive extraction, dependency execution or remote fetching is part of the contract. URL credentials, whitespace/control characters, relative URLs and non-web schemes are refused. Validation never fetches a URL. Renderer nodes must keep links inert until deliberately opened and must not load remote images or execute Markdown HTML.

Keyed readers verify the encrypted content's type commitment and attachment descriptor list against the public proof. Content is never interpreted as actions, actor or grants. Public replay cannot inspect private content; keyed replay rejects malformed artifact payloads. Existing controls still accept only `control.labels`; artifact content does not weaken that rule. `readArtifactPayload` is a content decoder and must be called only after verifying the proof chain.

### Blob descriptor and next-node crypto contract

A descriptor is exactly `{v:1,journey,id,epoch,size,ciphertextSize,nonce,digest}`. Epochs start at 1. Raw `size` is an integer from zero through 25,000,000 inclusive. `ciphertextSize` is exactly `size + 16`. `nonce` is canonical base64 for 12 random bytes; `digest` is canonical base64 SHA-256 of the binary ciphertext including the AES-GCM tag.

Binary blob encryption uses the journey epoch's 256-bit AES-GCM key and a fresh nonce. Associated data is UTF-8 canonical JSON for `{v:1,journey,id,epoch,size}`. Nonce travels in the descriptor, not prepended to the stored bytes. The blob-crypto node implements binary encryption/decryption; R2 stores those binary bytes, not base64 or data URLs. Base64 is used only when embedding bytes in the encrypted JSON archive. Readers verify digest, lengths and authenticated metadata. The 25,000,000-byte binary limit does not widen the JSON cap.

A later version may reuse an identical committed descriptor from an undeleted version of the same artifact. Descriptors cannot change after an ID is referenced. Cross-artifact references, including references previously used by a deleted artifact, conflict. All versions of an undeleted artifact retain live references, even attachments absent from the current head. Whole-artifact deletion ends those live references; cleanup must never remove a live reference. New staged blobs remain subject to uploader ownership, completion, current epoch and current-write checks in storage.

### New-input mapping and compatibility

`suggestedArtifact` maps `note`, `decision`, `question`, `learning`, `tension`, `practice`, `success`, `resource`, `position`, `interview` and `lesson` to `document` plus that same suggested tag. Other strings also map to `document` plus the original tag. Supplied tags are retained and exactly deduplicated. `recovery` returns no artifact and must not appear in artifact views/counts/searches/links. This helper handles only new create/import inputs. It performs no historical migration, rewrite or trust bootstrap.

Stage 1 uses client/interface version `0.1.5` and both capabilities `control-proof-v1` and `artifact-v1` (`X-Control-Format` and `X-Artifact-Format` headers). `supportsArtifacts` refuses old/malformed versions, missing capabilities and a newer signed minimum. New journeys require Stage 1; Stage 0 fixtures can raise their signed minimum before the first artifact action. Consumers must fail with an update message before partial content, not skip unknown actions. Live agent links remain deliberately server-readable, read-only and limited to their existing overview; attachment access requires the member interface.

### Versioned encrypted archives

`exportArtifactJourney` and `importArtifactJourney` use one age-encrypted JSON object:

```text
{format:'artifact-v1', version:1, journey, creator,
 controls:[{proof,envelope}], envelopes, wraps,
 blobs:[{descriptor,ciphertext}], unavailableDeletedBlobs:[blobId]}
```

`controls` retains the exact signed public chain and encrypted payloads, including tombstoned metadata. `envelopes` carries separate internal/ordinary records, not a second action chain. `wraps` uses existing `{epoch,recipient,ciphertext}` key wraps. `blobs` contains canonical base64 ciphertext for every referenced blob in every undeleted version, exactly once. `unavailableDeletedBlobs` names the distinct historical references no longer live; deleted blob bytes are not exported.

Import and export both verify the archive against separately pinned `{journey,creator}`, public signatures and the full chain before returning content. All control keys must be available, keyed payloads must match their public projections, and blob digests, lengths, AES-GCM metadata and surviving references must verify. Missing live bytes, unreferenced bytes, duplicate IDs and unexpected fields fail. Only named fields survive output. Archive format/version mismatches are refused; legacy `importJourney` is separate and is not a Stage 1 migration path. A complete valid earlier chain is still a possible rollback without an external checkpoint. Downloaded archives, keys and content cannot be recalled.

The Bend proofs cover symbolic authority and reference transitions in production functions. They do not claim cryptographic certification, upload atomicity or future UI rendering safety.

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
