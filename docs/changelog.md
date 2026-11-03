# Changelog

What shipped in the Wayfinding rewrite, newest first. Each entry lists the commits, and the live deploy where there was one. The proof of concept runs at https://poc.wayfinding.support. The reasons behind these changes are in `docs/decisions.md`.

## 2026-11-03

The rewrite merged to `main` as merge commit `ca48bdd` (pull request 9). The stacked stage pull requests were closed as superseded.

### Passkeys

- Each passkey shows its provider name (such as 1Password), or a name you give it. The raw ID is no longer shown. (`a3f960f`)
- Each passkey shows when it was added and when it was last used.
- After a passkey is added, renamed or used, the page shows a confirmation.

### Console

- A header with an account menu. (`3586218`)
- Sections shown as cards.
- Connected clients shown by readable name.
- Capabilities shown as chips.
- The confirmation page names the agent. (`c160532`)

### Sign-out

- Signing out lands on the home page. (`d0efa6b`)
- The next sign-in asks for credentials again. (`12acaaa`)
- An attempt to also end the AuthKit session was reverted, because the WorkOS logout endpoint returned a blank page. (`8dcfdc2`, `e66515e`, reverted in `bd35a1a` and `5f92caf`)

### Fixes

- One stored console record that failed validation no longer blocks every sign-in. (`b1c8fff`)
- CI: `@noble/hashes` is now declared, because ts-mls imports it without declaring it. (`9bf84d3`)
- CI: the Apps test harness now waits longer on slow runners. (`54d0788`)

**Deploys:** `6131969e`, `a1013e74`, `4261d960`, `b39782a0` (live).

## 2026-10-30

### v2

Plan: `.work/drafts/v2.md` (`61c8202`). Human ontology: `docs/ontology.md`.

- **Rules:** a capability catalogue, cards, client bindings, library items, boards, topics, posts and rounds. All are proved over any stored state. (`65cae8d`, `3cbcad2`)
- **Agents:** account-level agents with capability cards. Clients can be bound to an agent with a passkey assertion. (`0d896c9`, `0e76627`)
- **Console:** `/console` with AuthKit sign-in using PKCE, CSRF-protected forms and WebAuthn passkeys. (`0a66cad`, `95048c5`)
- **Library:** labelled artifacts of 14 kinds, with search, versions, visibility and private storage. (`88c8e21`, `3021433`)
- **Forum:** boards, topics and posts, plus conversations attached to projects and artifacts. (`1eeb25a`, `9f12265`)
- **Sensemaking:** rounds with private interviews, contributions and `round_next`. (`e4a4610`, `3c7632b`)
- **Views:** MCP Apps views for the library, forum, rounds and agent capabilities, and journey pages in the console. (`0a378db`, `4ff6d8b`)
- **Storage:** v2 state lives in fresh `JourneyV2` and `AccountsV2` storage classes. (`0ea3b13`)
- **Test guide:** `docs/poc-test-guide.md` covers v2. (`2758b7a`)

### Fixes

- Signed-out visits to the console redirect to sign-in. (`f93c70e`)
- A landing page at `/` with an account menu. (`b21bbc4`)
- The token exchange uses `redirect: 'manual'`, because Workers reject `'error'`. (`1de1542`)
- The console accepts same-origin form posts that browsers send with `Origin: null`. (`2331bda`)

**Deploys:** `2268bfa1` (v2), `4a7198ee`, `2d8e2af3`, `87e9466f`.

## 2026-10-29

### Plan

The rewrite plan and Dan's decisions on it. (`53a9720` to `8062244`)

### Stage 0: foundations

- The legacy app was removed.
- The gdp-wired rules pipeline was added: `compileJs`, `rules.lock.json` and a tamper check. (`dd2ee33`, `29ba33f`, `3a8331d`, `8a2ca5f`)

### Stage 1: rules

- Journey, agent card, grant, project, artifact, task and personal group models, proved over any stored state. (`478caa3`, `59c44a1`, `0c0f370`)

### Stage 2: MCP server

- A Cloudflare Worker with AuthKit bearer auth, OAuth metadata and support for two protocol versions. (`313cedc`)
- Durable coordination tools. (`47718c2`, `2560ee5`)

### Stage 3: MLS and proxy

- A ts-mls group wrapper. (`405d14b`)
- The server relays opaque MLS messages and artifact ciphertext. (`64dabee`)
- Artifact deletion erases every stored version. (`96d6a0b`)
- A local MLS proxy serves encrypted artifacts over MCP. (`a3fea2f`)

### Stage 4: MCP Apps

- Self-contained journey views. (`5c62856`)

### Stage 5: tasks

- A task inbox, deadline alarms and the Tasks extension. (`305ff0c`)

### Proof of concept live

- Fixes for the WorkOS profile lookup on workerd, and a test guide. (`296233c`, `9ec5211`, `b7a6969`, `abaeb4e`)
- Nicknames, member names and email invitations. (`cfe2b08`)

**Deploys:** first proof of concept at https://poc.wayfinding.support. `efd2c395` added names.

## Not yet shipped

- **Stage 6:** cloud-client opt-in to server-side decryption.
- **Stage 7:** Dan's review of the rules and an independent security review. Real users and confidential data wait for both.
