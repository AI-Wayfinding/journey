# Journey server

This Worker serves `/v1/*` with Hono. Each journey lives in one SQLite-backed Durable Object (`EnclaveObject`). A second, fixed-name SQLite-backed object (`Registry`) holds accounts and the operator registry. We chose it instead of D1 to avoid a second storage product. The `v1` Durable Object migration in `wrangler.jsonc` creates both SQLite classes; each class records SQL schema version 1. Non-API paths return a plain 404. API errors are always `{ "error": { "code": "..." } }` and never include internals.

## API

| Method and path | Purpose |
|---|---|
| `POST /v1/auth/email/start` | `{email}`: send a magic link; always 202, with per-IP and per-email limits. |
| `POST /v1/auth/email/verify` | `{token}`: consume a 15-minute link; return a registration or sign-in challenge and a 12-hour cookie. |
| `POST /v1/auth/passkey/register/options`, `/register/verify` | Request user verification and PRF, then register a credential. |
| `POST /v1/auth/passkey/login/options`, `/login/verify` | Request user verification, then sign in with a passkey. |
| `POST /v1/auth/logout` | Revoke the cookie. |
| `POST /v1/journeys` | Create with `{id,name,creatorEmail,creator:{id,recipient,signingKey},genesis,wraps,recoveryWrap,minClientVersion}`. The client generates `id` before encrypting genesis. Each wrap is `{principal,epoch,wrap}`. |
| `GET /v1/journeys` | List accessible journeys and the account's principal IDs. |
| `POST /v1/journeys/:id/seq` | Reserve `{seq,epoch}` for five minutes, then use core `seal` to include that sequence in authenticated metadata. |
| `POST /v1/journeys/:id/records` | `{envelope}`: store at the reserved sequence, maximum plaintext size 1 MiB. |
| `GET /v1/journeys/:id/records?after=&limit=` | Read ciphertext after a sequence, up to 100 records per request. |
| `POST /v1/journeys/:id/log` | Append `{entry,accessChanges,memberWraps?,wraps?,epoch?}` atomically. `entry` is base64url of an encrypted log envelope. `memberWraps` add current-epoch wraps; `wraps` and `epoch` rotate the key. Access changes have `{principal,action,kind,scope,expiresAt?}`. |
| `GET /v1/journeys/:id/log?after=` | Fetch up to 1,000 encrypted log entries; default `after=-1`. |
| `GET /v1/journeys/:id/wraps/me` | Fetch only the caller's epoch wraps. |
| `GET /v1/journeys/:id/export` | Stream JSON with encrypted `log`, `envelopes`, and only the caller's `wraps`; the client verifies entries and builds an age-encrypted export with core. |
| `POST /v1/journeys/:id/invites` | `{inviteIdHash,expiresAt}`: create a one-use invite that expires within seven days. |
| `GET /v1/journeys/:id/invites/pending` | List pending public keys for a holder's device. |
| `POST /v1/invites/accept` | `{inviteId,principal:{id,recipient,signingKey}}`: consume an invite and wait for the holder's add and wrap. |
| `POST /v1/agent-sessions`, `GET /v1/agent-sessions/:id` | Request `{journeyId,agentPublicKey:{recipient,signingKey},requestedScope,remembered?}`; receive a six-digit code and approval URL, then poll the opaque session ID. |
| `POST /v1/agent-sessions/:id/approve` | A person with recent passkey verification sends `{code,principal,scope,expiresAt,wrap,entry}`. |
| `GET /v1/admin/registry` | Constant-time checked `Bearer ADMIN_TOKEN`; returns registry metadata only. |

## Sign-in and invites

Every state-changing request needs `Origin: https://app.wayfinding.support` and `X-Wayfinding: 1`. A person sends the httpOnly, Secure, SameSite=Strict `wayfinding_session` cookie and `X-Principal` on journey routes. Magic-link start always follows the same account-independent issuance path and returns 202, whether the account exists or not. Email addresses are normalized and hashed with HMAC-SHA-256 under `EMAIL_HASH_KEY`. A verified email session can register or request a login assertion, but cannot access journeys until passkey verification succeeds. WebAuthn uses `RP_ID` and `ORIGIN`; the browser should retain the PRF extension to unlock its local identity. The server stores the credential public key, counter and transports, not the PRF result.

The holder makes 32 random bytes, puts them after `#` in the invitation URL, and posts their base64url SHA-256 digest as `inviteIdHash`. The fragment never goes to the server in the link request. The invitee submits the random value as `inviteId`, proves email control and registers a passkey. The server consumes the invite once and holds the new principal as pending. A holder's device verifies the signed log, posts an encrypted `member.add` entry with an access addition and `memberWraps`, then the new principal can read. `inviteSecretProof` is reserved for a later proof design; this version checks the hash preimage supplied as `inviteId`.

For removal the holder's device posts encrypted `member.remove` with an access removal. The object immediately denies that principal and pauses all writes until a signed `key.rotate` entry is posted with the next `epoch` and `wraps` for remaining principals. Old ciphertext remains under the earlier key. Devices retry an interrupted rotation.

## Agent signatures

Approval checks a matching six-digit code and a passkey verified within five minutes. A session expires within eight hours. A remembered agent can last up to 90 days. Agents cannot call passkey endpoints. Every signed journey request sends `X-Agent-Session`, `X-Agent-Timestamp` (Unix milliseconds), `X-Agent-Nonce` (fresh random string) and `X-Agent-Signature` (base64url Ed25519 signature). Sign UTF-8 of the following fields separated by a single LF, without a trailing LF:

```
METHOD
PATH_WITH_QUERY
BASE64URL_SHA256_EXACT_BODY_BYTES
TIMESTAMP
NONCE
```

GET has an empty body. The path has no host or fragment. The server rejects timestamps more than 60 seconds away, bad signatures, expired agents and reused nonces. Nonce pairs remain in the registry for 60 seconds. After approval, the agent signs a request for its wrap.

## Storage and trust

Plain storage: journey ID and name, creator email in the creator's registry row only, record metadata and size, timestamps, member count, storage estimate, minimum client version, account email *hashes*, credential public keys, opaque principal IDs with kind/scope/expiry, an opaque link from an approved agent to its approving person (needed to remove their agents together), and pending invite public keys. Later members' emails are not stored in plain text. The operator can guess an email against its keyed hash; request timing can link active accounts. Email delivery exposes destinations to the mail provider.

Encrypted storage: record envelopes, signed membership entries inside encrypted log entries, and age key wraps. The server never holds an epoch key, a PRF result or item plaintext. **Clients must encrypt log entries before sending them:** the Worker treats them as opaque bytes and cannot prove that a hostile client really encrypted them. Devices verify the complete signed log and decide who may receive a key; the server checks only its access list, never grants or the at-least-one-holder rule. A write-scope caller can change that list without a matching valid log entry. This can deny service or grant ciphertext access but cannot make an honest device supply a key. The server can withhold or replay old valid data; clients need their own checkpoint to detect rollback. Registry counters and journey listings may lag after a cross-object interruption; `EnclaveObject` remains authoritative for access. `lastActive` tracks writes, and `storageBytes` estimates stored ciphertext rather than SQLite overhead.

## Local checks and configuration

Run `npm ci` at the root, `npm run build -w packages/core`, then `npm run typecheck -w packages/server` and `npm test -w packages/server`. Tests run in workerd with SQLite objects and a software P-256 passkey authenticator. Email delivery alone is faked at the binding; no Cloudflare API is called. `wrangler.jsonc` declares `REGISTRY`, `ENCLAVES`, `MAGIC_EMAIL` from `noreply@wayfinding.support` with no destination restriction, per-IP and per-email rate-limit bindings, `RP_ID`, `ORIGIN`, the custom domain, and `workers_dev: false`. Provision `EMAIL_HASH_KEY` and `ADMIN_TOKEN` as secrets; neither belongs in the config. Deployment and Cloudflare resources belong to the parent. Attachments, open journeys and storage quotas beyond individual records are outside M2.

## Known M2 limits

The server stores `recoveryWrap`, but M2 has no endpoint for a person who has lost every passkey to retrieve it. Keep the matching wrap with the printed recovery identity until a recovery flow exists. Core `delete` records are still append-only here; physically purging stored versions needs a later API and device-led policy. Neither gap gives the operator a decryption key.
