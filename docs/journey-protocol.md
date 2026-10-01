# Journey protocol v1

A **journey** is an encrypted team space. Its technical name in the package is **enclave**. This document covers the portable format; services and clients manage account sign-in, passkeys, caches, and delivery separately.

## Keys and records

Each person and agent has an X25519 age recipient. Agents can use non-extractable Web Crypto private keys; a person's exportable identity and Ed25519 signing key are encrypted with a key from one passkey outside this package. The passkey is also used for sign-in. A random 256-bit journey key belongs to a numbered **epoch** (one generation of the key). It is age-wrapped separately for every current member and agent. Removal creates the next epoch and gives wraps only to those who remain. Existing records stay under their old keys.

Every item is an append-only encrypted version. The plain envelope is `{ outside: { v:1, id, journey, seq?, epoch, size, createdAt }, nonce, ciphertext }`, with base64 nonce and ciphertext. The outside has no record type. The nonce is 96 random bits; AES-GCM authenticates the ciphertext and all outside fields. The service must allocate `seq` before sealing if it wants a sequence there. `size` is the unencrypted UTF-8 JSON byte length, not the ciphertext length. The inside is `{ type, typeVersion, body }`, including optional unknown fields. Unknown types and unknown values remain intact when records are read and saved; known breaking versions can upgrade on read through registered converters. A client too old to meet the journey's signed minimum version may read but must not write.

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

`envelopeHash` is base64 SHA-256 of canonical JSON for the exact complete envelope, including outside fields, nonce and ciphertext. The proof signature uses the same canonical JSON and Ed25519 procedure as legacy entries, omitting only `sig`. Sequence numbers continue the signed log. `prev` is the hash of the previous complete proof, or the last legacy signed entry at migration. The envelope's journey and sequence must match the proof. Changing ciphertext, actor, journey, public body or position invalidates verification.

`verifyControlProofs` verifies chain, pinned creation identity, public field shapes and signatures before sending the action to compiled Bend rules. Access rows supplied by callers are never creation or migration trust. The original signed legacy history may initialize replay; a service must establish and pin its migration checkpoint against the actual stored journey rather than accept an arbitrary history or current access row as proof.

Keyed readers reconstruct display fields with `readControlProof` only after proof verification. Each decrypted label must match its public digest. A missing key, malformed label payload or wrong digest makes the label `[unavailable]`, with its field listed in `unavailableLabels`. The signed action still applies. Labels never decide permissions. Public replay also uses unavailable labels, not digest strings presented as names or emails. The reconstructed entry's `sig` belongs to the public proof, not to an independent legacy `LogEntry`; do not pass reconstructed entries to `verifyLog`.

### Legacy upgrade

Keep all original signed entries, encrypted content and old key wraps unchanged. Verify legacy signatures and chain with `verifyLog`, pinned to the journey's original creator. Legacy normal people retain read-write access and their person guides; agents retain their original limits. Support people retain read-only access and expiry. Absent settings mean private visibility, invitation-only joining and a read-write default, matching the existing invite flow.

Before the first incompatible control, a current guide signs the existing `client.minVersion` entry with a minimum greater than `0.1.3` (currently `0.1.4`). Its legacy entry hash anchors the first proof. A minimum cannot decrease. New `journey.settings`, `member.role` and `member.renew` entries require the barrier. An old reader must update before writing or applying unfamiliar controls. Do not silently rewrite history or infer guide authority from writable access rows.

Visibility changes, projects, artifact migration, private interview access and public joining can add their own record/version boundaries in later stages; Stage 0 adds no unused implementations for them. Unknown membership controls must still stop verification, never be ignored.

## Removal and export

`removeAndRotate` produces legacy signed removal and next-epoch entries, a fresh key, and one age wrap per remaining member and agent when a remaining guide performs both operations. It refuses self-removal because that person could not sign rotation. `removeMemberEntry` lets a person of either role sign their own leave or removal of their own agent, and lets a guide remove another member. Removal cascades to a person's agents and cannot remove the last person guide. `completeRotation` lets a remaining guide of either role finish delivery. Personal removal authority never grants rotation authority. These helpers produce legacy entries; proof-based callers use the same verified state and effects, but seal only labels and sign `ControlProof` for each action.

For upgraded journeys, removal makes rotation pending: content writes and sequence reservations must stop, while authorized controls, including guide-only rotation, remain possible. Removal and rotation cannot recall already downloaded keys or copies; future records and keys go only to survivors. Helpers cannot atomically deliver changes or enforce server access by themselves.

An export is one age-encrypted JSON file with `log`, `envelopes`, and `wraps`. `importJourney` verifies membership signatures, the chain, and each envelope it can decrypt before returning the archive. Keep historic wraps if historic records must remain readable. An archive and the server can still withhold records or present a prior valid history; retain a separate checkpoint if detecting rollback matters.

## M2 service wire formats

The Worker API lives under `/v1`. Clients generate a journey ID with `newId` before encrypting genesis, then send that `id` when creating the journey. A record's `outside.seq` is authenticated by core, so the client calls `POST /v1/journeys/:id/seq` before sealing and sending `POST /v1/journeys/:id/records`. The server returns `{seq,epoch}`; a five-minute reservation is bound to the authenticated principal. A write under an old epoch returns `old-epoch` and the client must fetch current wraps. Each record is at most 1 MiB of plaintext. The client verifies all signed entries, not the server.

The following is the legacy M2 wire format, not the Stage 0 authority contract. Stage 0 service/client adapters must use the verified public control above and derive access effects from it, never trust plain row instructions.

A legacy log request contains `entry`, the base64url encoding of a JSON core envelope whose encrypted body contains the signed `LogEntry`. The server assigns an outer log sequence and stores only the opaque bytes. `accessChanges` is a plain server access-list instruction containing `{principal,action:'add'|'remove',kind:'person'|'agent',scope:'read'|'readwrite',expiresAt?}`. It does **not** carry a signed grant. `memberWraps` supplies `{principal,epoch,wrap}` for additions to the current epoch; a rotation uses `epoch` and `wraps` for the next epoch. The client posts removal and rotation as separate signed entries. The object blocks new writes between removal and rotation. On rotation, every new wrap belongs to a non-removed principal. The device checks that this set matches its verified log.

An invite uses 32 random bytes placed after `#` in the link. Only the base64url SHA-256 digest is posted as `inviteIdHash`. The invitee sends the random preimage as `inviteId` to `/v1/invites/accept` after email and passkey verification, together with their new principal ID and public keys. The server consumes the invite once and stores a pending principal without the invitee's plain email. A holder's device reads `/v1/journeys/:id/invites/pending`, verifies the signed log, signs and encrypts `member.add`, and posts it with the access addition and `memberWraps`. An invite does not itself grant read access. An optional `inviteSecretProof` field is reserved for a later proof scheme; M2 checks the random preimage against its digest.

An approved agent signs each journey request with its Ed25519 signing key. The four headers are `X-Agent-Session` (opaque session ID), `X-Agent-Timestamp` (Unix milliseconds), `X-Agent-Nonce` (fresh string), and `X-Agent-Signature` (base64url). The signature covers UTF-8 of `METHOD\nPATH_WITH_QUERY\nBASE64URL_SHA256_EXACT_BODY_BYTES\nTIMESTAMP\nNONCE` without a final newline. `METHOD` is uppercase; `PATH_WITH_QUERY` starts with `/` and includes the raw query string but no host; an empty GET body hashes as empty bytes. The server rejects requests more than 60 seconds from its clock and stores used nonces to prevent replay. Agents do not get a browser session cookie.
