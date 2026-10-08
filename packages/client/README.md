# Journey agent client

The `wayfinding` command gives an agent access to one encrypted journey after a person approves it. It also runs a Model Context Protocol (MCP) server over standard input and output. Authenticated member agents have exactly their adding person's live capabilities (D45), including content, guide controls and private access. They sign as themselves. Old stored agent scopes are accepted and ignored. A read-only person and their agents cannot write content; project participation permits metadata changes, not content-write elevation.

## Install

Node.js 22 or newer is required. Install from npm:

```sh
npm install -g @ai-wayfinding/client
wayfinding --help
```

If your system does not allow a global install, install to a folder you control:

```sh
npm install -g --prefix "$HOME/.npm-global" @ai-wayfinding/client
export PATH="$HOME/.npm-global/bin:$PATH"
wayfinding --help
```

### Build from this repository

From a clone of this repository:

```sh
npm ci
npm run build -w packages/core
npm run build -w packages/client
npm pack -w packages/core
npm pack -w packages/client
# Install both local tarballs together.
npm install -g ./ai-wayfinding-core-*.tgz ./ai-wayfinding-client-*.tgz
wayfinding --help
```

If a global install is not wanted, run `node packages/client/dist/cli.js --help` from the clone after building. A GitHub URL is not a reliable npm install target for one package inside this workspace; installing the root does not install the client binary.

## Connect to a journey

```sh
wayfinding connect <journey-id> --scope read
wayfinding connect <journey-id> --scope readwrite --remember
```

The journey server defaults to `https://app.wayfinding.support`; use `--server https://your-server` if needed. The single-process command creates a new age encryption identity and signing key **in memory**, asks the server for approval, and prints a link and a six-digit code. Open the link in your browser, check that the code matches, choose the approved access and time, then confirm with your passkey. The command waits until approval, expiry, or lockout. Approval is valid for at most 8 hours without remembering, or 90 days when remembered. The person must choose remembered access in the approval screen before keys are saved; the client refuses expired keys.

Without `--remember`, the one-shot `connect` command does not save keys. It closes the connection when it exits. Start `wayfinding mcp --connect <journey-id>` to keep an in-memory connection for that MCP process, or pass `--journey <journey-id>` to an individual CLI command to ask for fresh approval on each invocation. There is no background daemon or invisible persistent login.

### Connect when each command runs in a fresh process

```sh
wayfinding connect YOUR_JOURNEY_ID --name "Research assistant" --state "$HOME/wayfinding-agent.json" --no-wait
# Open the printed link in a browser and approve after checking the six-digit code.
wayfinding connect --state "$HOME/wayfinding-agent.json" --wait --timeout 600
wayfinding list --state "$HOME/wayfinding-agent.json"
wayfinding mcp --state "$HOME/wayfinding-agent.json"
```

`--no-wait` creates a pending request, writes its keys, request ID, server and expiry to a **0600** state file, then prints the link and code and exits. It refuses an existing file (especially one without private permissions). `--wait` uses that file to poll and can be safely retried after a timeout; it becomes an approved session file after approval. The file expires with the approved session, never later than eight hours after creation. Expired files are deleted and refused. Keep the file private; it contains unencrypted keys. Delete it when finished. This is separate from `--remember`, which still uses the keychain or an encrypted key folder. Use `--state FILE` on `add`, `import`, `list`, `search`, `show`, `comment`, `comments`, `status`, or `mcp`.

Pass `--json` on either connect step to print a single JSON object with `link`, `code`, `requestId`, `expiresAt` (ISO 8601), and `status`. Exit status **0** means the request was created or access was approved; **2** means approval is still pending after `--wait` times out; **3** means expired; **4** means denied or locked out; **5** means the server or proxy cannot be reached. Other errors use exit status 1. The client automatically uses `HTTPS_PROXY`, `https_proxy`, or `HTTP_PROXY` when set. If a connection fails, it reports the underlying cause and advises checking the proxy or asking the workspace admin to allow `app.wayfinding.support`.

With `--remember`, agent keys go to macOS Keychain (`security`) or Linux Secret Service (`secret-tool`). Unlock/install that service first. If the OS keychain is unavailable or the platform is unsupported, the command refuses instead of storing unencrypted keys. Windows users can use `--key-folder <path>` with a passphrase; there is no Windows Credential Manager adapter. On every OS, `--key-folder <path> --remember` stores an age-passphrase-encrypted `agent.age` in a private folder (0700 folder, 0600 file on Unix). Set `WAYFINDING_PASSPHRASE` or enter it at the terminal when prompted; the passphrase is never stored. Do not choose a shared folder.

`wayfinding disconnect` removes the remembered keys and the local cache. When using `--key-folder`, pass the **same folder** to both connect and disconnect. Server-side membership remains until the person removes the agent or the approval expires.

## Work with an approved journey

```sh
wayfinding status
wayfinding list --type document --tag resource
wayfinding search "journey words"
wayfinding show <item-id>
wayfinding add --type link --title "A useful link" --url https://example.org --summary "Supplied summary" --notes "Notes" --tags reading,guide
wayfinding add --type file --title "Local file" --file ./report.pdf
wayfinding import-skill ./my-skill --title "Local skill"
wayfinding versions <item-id>
wayfinding edit <item-id> --predecessor <version-id> --type document --title "Updated" --body "New Markdown"
wayfinding download <item-id> --blob <blob-id> --output ./downloaded.pdf [--version <version-id>]
wayfinding delete <item-id>
wayfinding import ./notes.md
wayfinding import ./markdown-folder
wayfinding comment <item-id> "A follow-up"
wayfinding comments <item-id>
```

Active types are `skill`, `prompt`, `document` (Markdown), `image`, `file`, `data` and `link`. Data requires `--format json|csv|toml|yaml|sqlite`; use `--body` for text or `--file` for original bytes (SQLite requires a file). Links require an absolute HTTP(S) URL; supplied summaries and notes are not fetched. HTML, applets and sensemaking documents are reserved for later stages.

Text aliases such as `note`, `decision`, `resource`, `position`, `interview` and `lesson`, and other category strings, create a document with that suggested tag. `interview` is only this text alias, not an interview relationship. `recovery` is never a user artifact. Tags preserve case and remove exact duplicates.

Markdown imports read `title`, `type` (or `itemType`) and `tags` (comma-separated or inline array). The remaining Markdown is the body. Caller attribution, dates, grants and other front matter are ignored. Files must have `.md` extensions; directories are read recursively. A skill folder requires `SKILL.md`, stored as text, with up to eight local attachment files. Package paths are relative display names, never download destinations. No ZIP extraction or dependency execution occurs.

Files are explicit regular local paths, not symlinks or remote URLs. Each version supports up to eight attachments, each at most **25,000,000 raw bytes**, including empty files. Binary bytes are encrypted before upload to private storage. MCP `files` entries accept only `path`, optional `packagePath` and optional `mime`. Downloads require an explicit new output path, refuse overwrites and use private file permissions. File and image artifacts need a primary attachment; CLI uses the supplied `--file`.

Artifact IDs stay stable. Every edit requires the observed predecessor version; stale edits fail with a conflict. Title, content, tags and attachments form a complete version. Omit files to retain existing attachments; MCP can supply a replacement `files` list (including `[]`). Any currently read-write member can edit or delete, not only the creator. Signed controls fix the original author and record the actual version writer. `show` includes versions and whole-artifact comments; comments optionally cite a version (`comment --version VERSION` or MCP `onVersion`). Deletion hides all versions/comments/downloads but retains signed and encrypted metadata history. This is not secure erasure; downloaded copies cannot be recalled.

Each read checks the full signed journey controls and their encrypted labels. Before a write, the client checks them again and uses the compiled Bend access rules. An agent's effective access equals the adding person's current role and guide authority. Old approval scopes do not cap it. `status` reports that current effective access. Removing the person ends their agents' access. The client also checks the required version before encrypting an item or comment locally. Server requests are signed with the method, path and query, body digest, timestamp, and fresh nonce. If access ends, the client says so and stops. Decrypted items remain in memory for the process lifetime; keys are also stored in a file only when you explicitly use `--state`.

Stage 1 requires client 0.1.5 and the `artifact-v1` capability. Older clients must update. If the required minimum rises or an unsupported control appears, CLI and MCP stop before returning content or writing. Run `npm install -g @ai-wayfinding/client@latest`, then retry with the same connection; do not request approval again. Legacy journeys were purged by server schema v2, not migrated. A live agent link shows current signed journey settings and remains read-only; its server must be updated if it cannot understand the controls.

### Projects inside a journey

Projects group artifacts; they do not change who can read them. Stage 2 requires client **0.1.6** and `project-v1`. Existing histories without project actions start with empty projects and unassigned artifacts; no migration or new approval is needed.

```sh
wayfinding project list
wayfinding project create --purpose "Work on the shared question"
wayfinding project show <project-id>
wayfinding project join <project-id>
wayfinding project leave <project-id>
wayfinding project purpose <project-id> --purpose "Revised purpose" --predecessor <observed-sequence>
wayfinding project state <project-id> --project-state active --predecessor <observed-sequence>
wayfinding artifact project <artifact-id> <project-id> --predecessor null
wayfinding artifact project <artifact-id> none --predecessor <observed-placement-sequence>
wayfinding list --project main
wayfinding list --project <project-id> --type document --tag resource
wayfinding search "question" --project all --type document --tag resource
```

`project list` includes empty and archived projects. `project show` returns purpose, state, revision, signed history, person participation records and effective participants (including live agents). Creation requires ordinary content-write access, starts `getting-started` and joins nobody. People and their agents may sign join/leave actions for the person's participation. Agent `join` and `leave` post those signed actions, preserving the agent as actor. An agent follows its adding person, including when added after that person joined. Leaving or removal ends that inherited participation.

Participating agents may edit purpose/state under their person's participation, regardless of the person's content role; stored agent approval scopes are ignored. States are `getting-started`, `active`, `looking-for-others` and `archived`. Set another explicit state to reopen. Archives remain readable. Archive is a state label, not a content-write freeze: current content-write authority still permits artifacts, comments and placement. Metadata permission never permits artifact creation/edit/deletion, comments, placement or blob uploads. A key update blocks ordinary writes, not authorized project metadata.

For purpose/state use the `revision` observed in `project show`; for placement use `placementRevision` from `show`, initially `null`. These are signed proof sequence numbers, not artifact version IDs. A stale edit conflicts: reread and decide again. Placement requires current content-write access even without project participation. It assigns, moves or clears one project pointer without changing the artifact's author, content version or attachments.

`list` and `search` default to **main**, the unassigned artifacts. `--project main|PROJECT_ID|all` selects the grouping and intersects with type/tag/text filters. Direct `show`, comments, versions and downloads are not restricted by project placement. Unknown project IDs and malformed selectors fail rather than returning partial results.

MCP adds `project_list`, `project_show`, `project_create`, `project_join`, `project_leave`, `project_purpose`, `project_state` and `artifact_project`. Use `id` for project/artifact IDs; `purpose` for text; `state` for an explicit state; `project` for placement (null clears). Purpose/state and placement require `predecessor` as a sequence number (null only for initial placement). MCP `list` and `search` accept `project: "main"|PROJECT_ID|"all"`, `type` and `tag`. All commands/tools use the existing approved connection and explicit local files; no credential handling changes.

### Optional encrypted-data cache

A remembered session uses a local cache by default. An in-memory connection uses no cache by default. Pass `--cache` to enable it for a one-shot command or `--no-cache` to disable it. Under the OS cache directory (macOS: `~/Library/Caches`; Linux: `$XDG_CACHE_HOME` or `~/.cache`; Windows: `%LOCALAPPDATA%`), the client stores **only ciphertext envelopes and the head of a freshly verified signed log**. The journey key, secret signing key, item titles, and item bodies never go to this cache. A `--state` file, when requested, is separate from this encrypted-data cache. On Unix, cache folders are 0700 and files 0600. The client verifies the full signed log again before every use. Disable the cache on a shared device.

## Connect an MCP tool host

The MCP server exposes `add`, `edit`, `versions`, `delete`, `download`, `import_skill`, `import`, `list`, `search`, `show`, `comment`, `comments`, `status`, and `connect_status`. Tool descriptions explain that the person approves access. Standard output is reserved for MCP messages; approval instructions go to standard error. With a remembered connection, use this command without `--connect`. With an in-memory connection, give the journey ID:

```json
{
  "mcpServers": {
    "wayfinding": {
      "command": "wayfinding",
      "args": ["mcp", "--connect", "YOUR_JOURNEY_ID"]
    }
  }
}
```

For Claude Desktop, after completing the two-step file-backed connection above, add this local MCP server to `claude_desktop_config.json` (replace the path with your private state file):

```json
{
  "mcpServers": {
    "wayfinding": {
      "command": "wayfinding",
      "args": ["mcp", "--state", "/absolute/path/to/wayfinding-agent.json"]
    }
  }
}
```

The earlier `--connect` example instead asks for approval when MCP starts. For Claude Code, use `claude mcp add wayfinding -- wayfinding mcp --connect YOUR_JOURNEY_ID`. For Codex, use `codex mcp add wayfinding -- wayfinding mcp --connect YOUR_JOURNEY_ID`. Use the absolute path to the built `cli.js` with `node` if `wayfinding` is not on the host's PATH. When the MCP process begins, the person sees the link and code in the host's standard-error log; approve it before the MCP connection finishes. Some hosts hide stderr: run `wayfinding connect <journey-id> --remember` in a terminal first, then configure `wayfinding mcp` without `--connect`.

The server/core authorize member and guide controls through the agent's live adding person. Authenticated agents receive every historical epoch wrap at admission, just like people. They never impersonate a person's signature. The current CLI/MCP provides content, project and private-vault APIs; it does not yet expose every guide/account workflow as a command. This is a missing interface, not an agent-only authorization ban.

`JourneyClient.openPrivateVault()` uses the person's vault with the agent's own keys and encrypted content-key wrap. The agent may initialize, create, edit and sign private content when its person can; private author/writer attribution stays the actual agent. The person and sibling authenticated agents share that vault. URL link credentials are excluded.

Private bundles use explicit local paths. `private handoff --output FILE --destination-state APPROVED_FILE` encrypts to a separately approved agent in the same person's audience. `private return --output FILE --destination-state APPROVED_FILE` sends the verified return to that approved recipient; without `--destination-state`, it encrypts to the current agent. MCP `private_handoff` and `private_return` use `path` and `destinationState`. `private import FILE` checks the recipient and live authority before staging the verified history. These commands require `--private-cache PATH`; exports never print private content or keys.

## Agent link (fallback)

Some agent sandboxes, for example Claude Cowork, cannot reach `app.wayfinding.support`, and many people cannot change the allowlist. If the CLI fails with exit code 5 ("Could not reach the journey server"), the agent can still read a web page with its web fetch tool. Ask the person to open their journey, go to **People & agents → Add agent by link**, choose how long the link should last (1, 7 or 30 days) and confirm with their passkey. They give you a link like `https://app.wayfinding.support/a/<secret>`. Read it with your web fetch tool; it returns JSON with the journey's items and people, in pages of under 12 KB (`page.next` holds the next page's URL).

- The link is **read-only**. To add something, give the person the text and ask them to add it in the journey.
- It is a deliberate exception to end-to-end encryption: while the link is live, Wayfinding's server decrypts the journey to answer it. Anyone with the link can read the journey until it expires or the person removes the agent.
- When `access.expiringSoon` is true, or the link answers 410, ask the person to open `access.renewUrl` and extend it with their passkey. The link stays the same.
- If the link answers 404, it has ended. Ask the person for a new one.

The CLI prints this hint after a network failure, and `--json` errors carry it in a `fallback` field.
