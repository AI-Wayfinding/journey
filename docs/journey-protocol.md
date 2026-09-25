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

Visibility changes and team-defined types can add new signed entry types in later protocol versions. A client that does not recognize them must update before applying the log.

## Removal and export

`removeAndRotate` produces a signed removal entry, a signed next-epoch entry, a fresh key, and one age wrap per remaining member and agent. Removal can take effect before rotation is delivered; the service must then block old-key writes until a holder completes the update. The helper refuses self-removal because that person would no longer be able to sign the rotation; another holder must complete it. It cannot atomically deliver changes or enforce server access by itself.

An export is one age-encrypted JSON file with `log`, `envelopes`, and `wraps`. `importJourney` verifies membership signatures, the chain, and each envelope it can decrypt before returning the archive. Keep historic wraps if historic records must remain readable. An archive and the server can still withhold records or present a prior valid history; retain a separate checkpoint if detecting rollback matters.

## M2 service wire formats

The Worker API lives under `/v1`. Clients generate a journey ID with `newId` before encrypting genesis, then send that `id` when creating the journey. A record's `outside.seq` is authenticated by core, so the client calls `POST /v1/journeys/:id/seq` before sealing and sending `POST /v1/journeys/:id/records`. The server returns `{seq,epoch}`; a five-minute reservation is bound to the authenticated principal. A write under an old epoch returns `old-epoch` and the client must fetch current wraps. Each record is at most 1 MiB of plaintext. The client verifies all signed entries, not the server.

A log request contains `entry`, the base64url encoding of a JSON core envelope whose encrypted body contains the signed `LogEntry`. The server assigns an outer log sequence and stores only the opaque bytes. `accessChanges` is a plain server access-list instruction containing `{principal,action:'add'|'remove',kind:'person'|'agent',scope:'read'|'readwrite',expiresAt?}`. It does **not** carry a signed grant. `memberWraps` supplies `{principal,epoch,wrap}` for additions to the current epoch; a rotation uses `epoch` and `wraps` for the next epoch. The client posts removal and rotation as separate signed entries. The object blocks new writes between removal and rotation. On rotation, every new wrap belongs to a non-removed principal. The device checks that this set matches its verified log.

An invite uses 32 random bytes placed after `#` in the link. Only the base64url SHA-256 digest is posted as `inviteIdHash`. The invitee sends the random preimage as `inviteId` to `/v1/invites/accept` after email and passkey verification, together with their new principal ID and public keys. The server consumes the invite once and stores a pending principal without the invitee's plain email. A holder's device reads `/v1/journeys/:id/invites/pending`, verifies the signed log, signs and encrypts `member.add`, and posts it with the access addition and `memberWraps`. An invite does not itself grant read access. An optional `inviteSecretProof` field is reserved for a later proof scheme; M2 checks the random preimage against its digest.

An approved agent signs each journey request with its Ed25519 signing key. The four headers are `X-Agent-Session` (opaque session ID), `X-Agent-Timestamp` (Unix milliseconds), `X-Agent-Nonce` (fresh string), and `X-Agent-Signature` (base64url). The signature covers UTF-8 of `METHOD\nPATH_WITH_QUERY\nBASE64URL_SHA256_EXACT_BODY_BYTES\nTIMESTAMP\nNONCE` without a final newline. `METHOD` is uppercase; `PATH_WITH_QUERY` starts with `/` and includes the raw query string but no host; an empty GET body hashes as empty bytes. The server rejects requests more than 60 seconds from its clock and stores used nonces to prevent replay. Agents do not get a browser session cookie.
