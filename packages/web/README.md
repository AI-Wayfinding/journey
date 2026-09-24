# Journey web app

This is the static single-page app served by the same Worker as the `/v1` API. Vite builds plain TypeScript, CSS and self-hosted fonts into `dist/`. It does not load an analytics script or a font from another site.

## Sign in and keys

A person confirms an email link, registers a sign-in passkey and an encryption passkey, and saves their age identity and Ed25519 signing key sealed to the encryption passkey. On later visits, sign in with the passkey and tap the encryption passkey to unlock. Chrome or Edge 116+, Safari 18+, and Firefox 139+ can support WebAuthn PRF; the passkey itself must support it too. There is no weaker fallback.

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

Playwright builds the app and starts `wrangler dev` on `localhost:18787` with the test-only `packages/server/test/wrangler.jsonc` and local Durable Objects in `.scratch/`. Its wrapper fakes email delivery and rate limits but uses real Worker routes, WebAuthn verification, signed journey requests and encrypted records. The Chromium CDP authenticator is configured with `hasPrf: true`; no test identity is compiled into production. The test covers sign-up, sign-in, invite admission, agent approval and signed write, comments, support read-only access, and removal with a rotated key. It does not contact a Cloudflare account.

The Worker cannot prove that a hostile client encrypted a log entry. Devices verify the full signed log before they trust membership or wrap a key. A server that replays an old valid log can only be detected with a separate client checkpoint; this app does not persist one. A later version could store a non-secret log hash without storing any usable keys.
