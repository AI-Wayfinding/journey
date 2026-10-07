# Wayfinding protocol core

`@ai-wayfinding/core` supplies the portable types and pure protocol operations for encrypted team spaces. An **enclave** is the technical name in code for that space; a **journey** is what people call it. This package has no server, network client, or storage adapter. It uses Web Crypto and age encryption in Node 22+, browsers, and Cloudflare Workers.

## Using the package

Install dependencies at the repository root with `npm ci`. Run `npm run typecheck -w packages/core`, `npm run build -w packages/core`, and `npm test -w packages/core`. Run the same tests in workerd with `npm run test:workers -w packages/core` and in Chromium with `npm run test:browser -w packages/core`. If your Chromium installation differs from Playwright's, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable.

Stage 1 uses client/interface version `0.1.5`, `control-proof-v1` and `artifact-v1`. Core and client package versions and consumer dependencies match this version; private server/web package versions are not protocol versions. New journeys require Stage 1; Stage 0 regression fixtures may retain a signed `0.1.4` minimum. A test for an unsupported future minimum uses `0.1.6`.

The top-level module exports `newId`, `createAgeIdentity`, `createAgentIdentity`, `createSigningIdentity`, `sealIdentity`, `openIdentity`, `generateJourneyKey`, `wrapJourneyKey`, `rotateJourneyKey`, `seal`, `open`, `parseRecord`, `serializeRecord`, `signEntry`, `verifyLog`, `removeAndRotate`, `exportJourney`, and `importJourney`. Age recipients and identities may also be custom implementations, including browser-only passkey recipients. An agent's X25519 private `CryptoKey` is non-extractable; a person's age identity and Ed25519 private key are strings that can be sealed to recipients for storage. Store neither unsealed private material nor a usable journey key on a server.

## Formats

An envelope has `{ outside, nonce, ciphertext }`. Only `outside` is plain: `{ v:1, id, journey, seq?, epoch, size, createdAt }`. `size` is the UTF-8 byte length of the encrypted JSON before encryption. `nonce` and `ciphertext` are base64. The decrypted JSON carries `{ type, typeVersion, body }`, with additional fields preserved. The twelve-byte AES-GCM nonce is fresh on each seal. Authenticated associated data covers **every** outside field, including `seq` when present; therefore, if the server assigns a sequence, it must reserve the sequence **before** the client seals the record. Changing it afterwards fails decryption. See [the public protocol](../../docs/journey-protocol.md) for item, comment, deletion, and membership details.

The following membership entry and archive formats are legacy APIs, not the current server authority format. A signed membership entry is `{ v:1, seq, prev, at, actor, type, body, sig }`. For signatures, remove `sig`, sort object keys by JavaScript string ordering recursively, keep array order, render compact JSON, encode UTF-8 and sign with Ed25519. The signature is base64. `prev` is the base64 SHA-256 hash of the complete preceding entry in the same canonical encoding, or `null` at genesis. `verifyLog` returns either a derived state or a typed error with a failing sequence number. Unknown membership types return `client-too-old`. Genesis may include an optional signed `description` (up to 2,000 characters) and `journeyKind` (`individual` or `team`); both stay in the encrypted membership log, not the plain registry. The export file is an age-encrypted JSON archive of the log, envelopes, and epoch key wraps; imports verify the log and open each encrypted envelope with an available identity.

## Stage 1 artifacts and binary files

Active types are `skill`, `prompt`, `document`, `image`, `file`, `data` and `link`. Formats reject unknown fields rather than preserving them. Legacy categories map only new creation/import inputs to document suggested tags; `recovery` never maps to a user artifact. No journey migration is provided.

Artifacts have stable IDs, immutable creators, fresh version/comment IDs, actual signed writers and current-predecessor conflicts. Any current read-write member may edit, comment or delete; guide authority grants no content writes. Bend decides authority, exact live adding-person capabilities for authenticated member agents (D45), and reference transitions. Legacy agent read/write settings are accepted and ignored. Agents inherit guide controls as well as content roles and project participation, but retain their own signing keys and attribution.

Agents have no vault. `PrivateVault` resolves agent-created private artifacts to the person's vault, readable and writable by the person and all their live authenticated agents with that person's current access. Initialization, headers and key delivery accept authorized agent signatures. URL agent-link credentials remain read-only and cannot read private content or existence. TypeScript verifies formats/signatures, copies named fields and performs crypto/transport effects.

`sealBlob`, `verifyBlob` and `openBlob` use binary AES-GCM with journey/blob/epoch/raw-size authenticated metadata. Each file allows zero through **25,000,000 raw bytes**, inclusive, plus exactly 16 ciphertext bytes. Versions allow eight distinct attachments. The separate JSON payload cap remains 1,048,576 bytes. Private filenames and MIME declarations stay in encrypted payloads, not bucket keys.

`exportArtifactJourney` and `importArtifactJourney` verify the signed chain, encrypted payloads, wraps and all surviving historic attachment bytes against separately pinned trust. Tombstoned metadata remains retained history, with deleted bytes explicitly unavailable. Deletion is not secure erasure, and downloaded copies cannot be recalled. See [the protocol](../../docs/journey-protocol.md) for exact wire fields and archive validation.

## Threat model

- The server sees journey identifiers, sizes, sequence numbers, epochs, timestamps and public signed authority fields, including member identifiers and grants. In current journeys, `ControlProof` is the sole authority and encrypted payloads carry private labels/content only. This is unsuitable for later author-private artifacts that must conceal existence. The server cannot decrypt ordinary envelopes without a member key; deliberately created live agent links are the labelled server-decryption exception.
- The server can deny service, delay writes, omit records, replay an old complete log, or refuse a key rotation. Clients need an independently retained log checkpoint to detect rollback; this package does not provide one.
- The server cannot forge a verified membership change or a new `members.manage` holder without an authorized person's or authenticated agent's Ed25519 signing key. Current callers use `verifyControlProofs` with a pinned journey/creator before wrapping keys or reading content. Legacy callers use `verifyLog`.
- A removed member cannot unwrap the new key epoch. They can keep everything they downloaded and any old key they already know.
- The server cannot alter an authenticated outside field or ciphertext without `open` failing. A client must still check the server's access policy and sequence allocation separately.
- A compromised member device or exported recovery identity can read whatever epochs that identity can unwrap. This package does not implement passkeys, account recovery, or secure device storage.
