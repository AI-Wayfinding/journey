# Journey web app

This is the static single-page app served by the same Worker as the `/v1` API. Vite builds plain TypeScript, CSS and self-hosted fonts into `dist/`. It does not load an analytics script or a font from another site.

## Sign in and keys

A person confirms an email link and creates **one passkey**. That passkey signs them in and protects both their age identity and Ed25519 signing key. Signing in, or opening a verified session in a new tab, takes **one passkey tap**: the same browser request proves their identity and returns the secret needed to unlock their keys locally. The server receives the signed proof, not the secret.

The passkey must support WebAuthn PRF (a way for a passkey to produce a secret only for this account). Chrome or Edge 116+, Safari 18+, and Firefox 139+ can request it, but the selected device or password manager must also support it. In Chromium with a virtual PRF passkey, sign-up took **one create call and no get calls**; sign-in and new-tab unlock each took **one get call**. When the test hides the PRF result from creation, sign-up takes **one create and one get call** with the same new passkey. The screen explains the extra tap before requesting it. No second passkey is created. If PRF is not enabled, sign-up stops before saving anything and tells the person to use device passkeys (iCloud Keychain or Google Password Manager) or a recent PRF-capable 1Password or Bitwarden. Real Safari and password-manager versions were not tested here; some browsers or managers may still omit PRF or require the extra sign-up tap. There is no weaker fallback.

The server keeps a random 32-byte PRF input for each account. The app uses the PRF output to derive a 32-byte AES-GCM key with HKDF-SHA256, a fixed versioned salt `wayfinding/person-keys/v1` and info `aes-gcm`. It encrypts each private key with a fresh 12-byte nonce and field-specific authenticated data. Only `{version:1,identity,signing}` ciphertext goes to the server. The PRF input is account-specific, so a passkey used for another account does not return the same key. The derived bytes and PRF byte arrays are wiped after use; Web Crypto's non-exportable key may remain in browser-managed memory until the request finishes.

Accounts made with the former two-passkey format must sign up again. The migration drops those old credentials and sealed keys. It does not convert old keys or old journeys; do not rely on this migration if any real journeys exist.

Usable private and journey keys stay in memory. They are cleared on sign-out, tab close or 30 minutes without activity. A retained reference to unlocked keys also stops working after clearing. The app never stores usable keys in browser storage. An invitation request token is not a key: it is briefly kept in this tab's `sessionStorage` so the email link can open in the same tab without losing the invitation, then removed when the person asks to join or signs out. The invitation token in a shared link is always a URL fragment, not a query parameter. A member must still let a new person in.

The recovery identity appears once when a journey starts. Save both lines shown on the recovery screen; the second line is the encrypted recovery wrap. The server cannot retrieve the identity. The existing M2 API has no recovery-without-passkey endpoint, so keep the wrap with the identity.

## Local tests

From the repository root, run:

```sh
npm ci
npm run build -w @ai-wayfinding/core
npm run typecheck -w @ai-wayfinding/web
npm run test -w @ai-wayfinding/web
npm run build -w @ai-wayfinding/web
npm run test:e2e -w @ai-wayfinding/web
```

Playwright builds the app and starts `wrangler dev` on `localhost:18787` with the test-only `packages/server/test/wrangler.jsonc` and local Durable Objects in `.scratch/`. Its wrapper fakes email delivery and rate limits but uses real Worker routes, WebAuthn verification, signed journey requests and encrypted records. The Chromium CDP authenticator is configured with `hasPrf: true` for the full journey and `hasPrf: false` for the no-PRF stop. The tests count WebAuthn create/get calls, not physical touches on a real device. No test identity is compiled into production. The full journey covers sign-up, sign-in, invite admission, agent approval and signed write, comments, support read-only access, and removal with a rotated key. It does not contact a Cloudflare account.

The Worker cannot prove that a hostile client encrypted a log entry. Devices verify the full signed log before they trust membership or wrap a key. A server that replays an old valid log can only be detected with a separate client checkpoint; this app does not persist one. A later version could store a non-secret log hash without storing any usable keys.
