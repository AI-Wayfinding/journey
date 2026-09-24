# Wayfinding protocol core

`@ai-wayfinding/core` supplies the portable types and pure protocol operations for encrypted team spaces. An **enclave** is the technical name in code for that space; a **journey** is what people call it. This package has no server, network client, or storage adapter. It uses Web Crypto and age encryption in Node 22+, browsers, and Cloudflare Workers.

## Using the package

Install dependencies at the repository root with `npm ci`. Run `npm run typecheck -w packages/core`, `npm run build -w packages/core`, and `npm test -w packages/core`. Run the same tests in workerd with `npm run test:workers -w packages/core` and in Chromium with `npm run test:browser -w packages/core`. If your Chromium installation differs from Playwright's, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable.

The top-level module exports `newId`, `createAgeIdentity`, `createAgentIdentity`, `createSigningIdentity`, `sealIdentity`, `openIdentity`, `generateJourneyKey`, `wrapJourneyKey`, `rotateJourneyKey`, `seal`, `open`, `parseRecord`, `serializeRecord`, `signEntry`, `verifyLog`, `removeAndRotate`, `exportJourney`, and `importJourney`. Age recipients and identities may also be custom implementations, including browser-only passkey recipients. An agent's X25519 private `CryptoKey` is non-extractable; a person's age identity and Ed25519 private key are strings that can be sealed to recipients for storage. Store neither unsealed private material nor a usable journey key on a server.

## Formats

An envelope has `{ outside, nonce, ciphertext }`. Only `outside` is plain: `{ v:1, id, journey, seq?, epoch, size, createdAt }`. `size` is the UTF-8 byte length of the encrypted JSON before encryption. `nonce` and `ciphertext` are base64. The decrypted JSON carries `{ type, typeVersion, body }`, with additional fields preserved. The twelve-byte AES-GCM nonce is fresh on each seal. Authenticated associated data covers **every** outside field, including `seq` when present; therefore, if the server assigns a sequence, it must reserve the sequence **before** the client seals the record. Changing it afterwards fails decryption. See [the public protocol](../../docs/journey-protocol.md) for item, comment, deletion, and membership details.

A signed membership entry is `{ v:1, seq, prev, at, actor, type, body, sig }`. For signatures, remove `sig`, sort object keys by JavaScript string ordering recursively, keep array order, render compact JSON, encode UTF-8 and sign with Ed25519. The signature is base64. `prev` is the base64 SHA-256 hash of the complete preceding entry in the same canonical encoding, or `null` at genesis. `verifyLog` returns either a derived state or a typed error with a failing sequence number. Unknown membership types return `client-too-old`. The export file is an age-encrypted JSON archive of the log, envelopes, and epoch key wraps; imports verify the log and open each encrypted envelope with an available identity.

## Threat model

- The server can see journey identifiers, sizes, sequence numbers, key epochs, timestamps, and a plain journey name. Membership entries must be encrypted by the client before server storage; storing the in-memory log format plainly would reveal member identifiers and grants. The server cannot decrypt an envelope without a member's key.
- The server can deny service, delay writes, omit records, replay an old complete log, or refuse a key rotation. Clients need an independently retained log checkpoint to detect rollback; this package does not provide one.
- The server cannot forge a verified membership change or a new `members.manage` holder without a current person's Ed25519 signing key. A client must call `verifyLog` before wrapping a key for anyone.
- A removed member cannot unwrap the new key epoch. They can keep everything they downloaded and any old key they already know.
- The server cannot alter an authenticated outside field or ciphertext without `open` failing. A client must still check the server's access policy and sequence allocation separately.
- A compromised member device or exported recovery identity can read whatever epochs that identity can unwrap. This package does not implement passkeys, account recovery, or secure device storage.
