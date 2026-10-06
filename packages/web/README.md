# Journey web app

This is the static single-page app served by the same Worker as the `/v1` API. Vite builds plain TypeScript, CSS and self-hosted fonts into `dist/`. It does not load an analytics script or a font from another site.

## Sign in and keys

A person confirms an email link, creates a passkey and saves eight one-time backup codes. They can add passkeys in Account, then remove old ones as long as one remains. Each passkey signs them in and protects its own sealed copy of the age identity and Ed25519 signing key. Signing in, or opening a verified session in a new tab, takes **one passkey tap**: the same browser request proves their identity and returns the secret needed to unlock their keys locally. The server receives the signed proof, not the secret.

The passkey must support WebAuthn PRF (a way for a passkey to produce a secret only for this account). Chrome or Edge 116+, Safari 18+, and Firefox 139+ can request it, but the selected device or password manager must also support it. In Chromium with a virtual PRF passkey, sign-up took **one create call and no get calls**; sign-in and new-tab unlock each took **one get call**. When the test hides the PRF result from creation, sign-up takes **one create and one get call** with the same new passkey. The screen explains the extra tap before requesting it. No second passkey is created. If PRF is not enabled, sign-up stops before saving anything and tells the person to use device passkeys (iCloud Keychain or Google Password Manager) or a recent PRF-capable 1Password or Bitwarden. Real Safari and password-manager versions were not tested here; some browsers or managers may still omit PRF or require the extra sign-up tap. There is no weaker fallback.

The server derives one stable 32-byte PRF input for the app. The app uses the PRF output to derive a 32-byte AES-GCM key with HKDF-SHA256, a fixed versioned salt `wayfinding/person-keys/v1` and info `aes-gcm`. It encrypts each private key with a fresh 12-byte nonce and field-specific authenticated data. Only `{version:1,identity,signing}` ciphertext goes to the server for each credential; a passkey's own PRF output is unique to that passkey. The derived bytes and PRF byte arrays are wiped after use; Web Crypto's non-exportable key may remain in browser-managed memory until the request finishes.

Backup codes use 16 fresh random bytes each, displayed once in Crockford base32. HKDF derives separate lookup verifiers and wrapping keys; the server stores only hashes of verifiers and encrypted copies of the same person keys. Recovery needs no email, but the one-time code only grants a short session to create a replacement passkey. It cannot open journeys on its own. The production class migration wipes all old accounts and journeys, so everyone must sign up again.

Usable private and journey keys stay in memory. They are cleared on sign-out, tab close or 30 minutes without activity. A retained reference to unlocked keys also stops working after clearing. The app never stores usable keys in browser storage. An invitation request token is not a key: it is briefly kept in this tab's `sessionStorage` so the email link can open in the same tab without losing the invitation, then removed when the person asks to join or signs out. The invitation token in a shared link is always a URL fragment, not a query parameter. A member must still let a new person in.

The recovery identity appears once when a journey starts. Save both lines shown on the recovery screen; the second line is the encrypted recovery wrap. The server cannot retrieve the identity. The journey recovery identity and wrap are separate from the account backup codes; keep both for restoring the journey's encrypted history.

## Journey settings and access

A guide manages people independently of their read-only or read-write content role. Either kind of guide can edit the journey name, description and default role for new people. Journeys remain private and invitation-only; visibility changes and other joining policies are not available.

Read-only people can change their own name and email choice, approve and manage their own agents, create and renew read-only agent links, and leave. The last guide cannot leave or give up guide authority. Removal revokes the removed person's agents too. A remaining guide completes key rotation before further content writes.

The browser verifies signed controls bound to their encrypted labels before showing settings or access. Unknown controls or a newer required version clear the view and show an update message; approval is not needed again. Server schema v2 purges legacy journeys rather than reading or migrating them. New journeys require client/interface version `0.1.6`, `control-proof-v1`, `artifact-v1` and `project-v1`. A remembered, account-scoped principal ID in this tab lets the authenticated protocol check show an update message when the server omits an incompatible journey from listings. This ID is not a key or an access grant.

## Artifacts and files

Journey members can create skills, prompts, Markdown documents, images, files, data and links. Suggested tags are optional; free tags keep their case and deduplicate exact values. Recovery records are separate and never appear in artifact lists, searches or counts. Types and original authors cannot change. Each save adds a version with its actual signer shown as writer. Whole-artifact comments keep a version ID for context. A stale edit fails with a reload message rather than replacing a newer version.

Files are encrypted in the browser before staging and binary upload to private R2 storage. The limit is **25,000,000 raw bytes per file, inclusive**; empty files are valid. Each version can contain up to eight attachments. Skill packages have required `SKILL.md` text and optional files with distinct relative paths. Downloads require current membership and verify the ciphertext descriptor and authenticated bytes before creating a temporary local download URL. No URL, Markdown, package or attachment is automatically fetched or executed. Inline images require validated PNG, JPEG, GIF or WebP bytes and successful local decoding; SVG and active formats stay download-only. Markdown HTML and remote images remain inert. Links display supplied text without fetching summaries and open only on a deliberate click with `noopener,noreferrer`.

Data views parse JSON, CSV, TOML, YAML and SQLite locally in a cancellable worker. Tables show the first 100 rows and 100 columns; structures allow 1,000 nodes, 100,000 displayed UTF-8 bytes and at most 64 levels. Input is capped at 25,000,000 bytes and each worker stops after ten seconds or cancellation. SQLite uses generated read-only queries and a 128 MiB engine memory limit, not user SQL, extensions or external access. YAML tags/aliases, malformed data and unsupported formats fall back to original-byte download. Formula-like CSV cells remain text.

Read-only access or a pending key rotation stops writes, including staged uploads. Current access is checked again before upload and commit through the shared Bend rules. Deletion hides the artifact, versions, comments and downloads, but retains signed proofs and encrypted metadata. It is not secure erasure and cannot recall downloaded copies. Exports include surviving files and explicit unavailable-deleted-blob IDs; the signed archive is verified before encrypting it to the person and their recovery recipient.

## Projects

Open Projects from a journey to create a grouping with a plain-text purpose. Creation starts at getting started and does not join you. Each person explicitly joins or leaves; their current agents follow without separate joins. Empty and archived projects remain visible. Participants of either content role can edit purpose and state, archive and reopen. These metadata controls do not permit ordinary artifact, comment, placement or file writes. Pending key rotation blocks those ordinary writes and project creation, but not authorized participation or metadata controls.

A saved artifact has a separate Project placement form. Assign, move or clear its single project without changing its author, versions, comments or files. Lists default to Main (unassigned). Choose one project or All artifacts; the choice stays in this tab across navigation and reload and intersects the existing type/text/tag search. Project counts are separate from the matching-list count. Participation never limits reading, versions, downloads or encrypted export, even in archived projects.

Purpose/state, participation and placement use the revision loaded with the page. A stale change fails with a reload instruction rather than overwriting newer work. Signed history records who changed what and when. The browser verifies the entire history before displaying content; unknown controls, bad payloads, missing capabilities or newer minimums cannot leave a partial project view. Purpose text is escaped, not interpreted as markup or fetched.

## Author-private artifacts

Open Author-private artifacts from a journey to create, read, version, comment on or delete a private copy. Private files use the same bounded local viewers as journey-visible files. Search and project placement are private to the author. Cross-journey copies keep their author and use independent copy keys, attachments and signed source histories. There is no private-to-public toggle or arbitrary recipient grant.

The member vault is server-backed, separate from shared records, blobs and exports. It has 64 fixed 1 MiB ciphertext slots. Opening a journey starts the portable vault lifecycle, including empty vaults. A save stages content locally; it does not upload immediately. The next 5-minute sync reads and writes exactly two slots and a signed header, including dummy commits. The screen distinguishes pending saves from verified committed history. Pending saves are discarded on lock, sign-out or leaving the journey lifetime; do not treat them as durable.

IndexedDB retains ciphertext and an independently encrypted signed checkpoint, not decoded private content. `openJourneyVault(ctx, paired)` accepts a trusted `PrivateCheckpoint` with `freshness: 'paired'` from another device. There is no pairing workflow or UI yet; callers must obtain that input out of band. Without it, the screen shows an unverified freshness warning even for a signature-verified server head. A retained checkpoint refuses older signed heads. Server-backed storage is not an offline freshness guarantee, and removing access cannot recall downloaded keys or copies.

Private backup/import uses a separate download encrypted to the person's existing keys, never the journey recovery recipient. Imports cannot replace newer history or resurrect deletions. Verified device snapshots can be submitted for portable fork merging; higher artifact versions win and tied versions remain visible rather than silently replacing one another.

Agent handoff uses a local one-use challenge requiring both signing-key and age-key possession by an eligible authenticated agent. The agent reads the person's scoped content; the person reviews and records the result. Agent authorship is not enabled. Link credentials never receive private content.

Browser Stage 3 evidence runs with:

```sh
npm run test:e2e -w @ai-wayfinding/web -- e2e/stage3-private.spec.ts
```

## Local tests

From the repository root, run:

```sh
npm ci
npm run build -w @ai-wayfinding/core
npm run typecheck -w @ai-wayfinding/web
npm run test -w @ai-wayfinding/web
npm run build -w @ai-wayfinding/web
npm run test:e2e -w @ai-wayfinding/web
npm run test -w @ai-wayfinding/web -- src/stage1-viewer.test.ts
npm run test:e2e -w @ai-wayfinding/web -- e2e/stage1-artifacts.spec.ts e2e/stage1-viewer.spec.ts
npm run test:e2e -w @ai-wayfinding/web -- e2e/stage2-projects.spec.ts
```

Playwright builds the app and starts `wrangler dev` on `localhost:18787` with the test-only `packages/server/test/wrangler.jsonc` and local Durable Objects and R2 in `.scratch/`. Its wrapper fakes email delivery and rate limits but uses real Worker routes, WebAuthn verification, signed journey requests and encrypted records. The Chromium CDP authenticator is configured with `hasPrf: true` for the full journey and `hasPrf: false` for the no-PRF stop. The tests count WebAuthn create/get calls, not physical touches on a real device. No test identity is compiled into production. The full journey covers sign-up, sign-in, invite admission, agent approval and signed write, comments, support read-only access, and removal with a rotated key. It does not contact a Cloudflare account.

Run browser and client integration suites one at a time: both own port 18787 and stop their local servers on completion. Stage 1 guard-removal checks run with `node scripts/check-stage1-negative-controls.mjs`; see [the proof contract](../../docs/journey-protocol.md#local-integration-checks).

The Worker cannot prove that a hostile client encrypted a log entry. Devices verify the full signed log before they trust membership or wrap a key. A server that replays an old valid log can only be detected with a separate client checkpoint; this app does not persist one. A later version could store a non-secret log hash without storing any usable keys.
