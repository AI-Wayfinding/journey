# Journey agent client

The `wayfinding` command gives an agent access to one encrypted journey after a person approves it. It also runs a Model Context Protocol (MCP) server over standard input and output. Agents can read, add items, and comment; **they cannot change journey membership or access**. Read-only agents cannot write.

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
wayfinding connect YOUR_JOURNEY_ID --scope read --name "Research assistant" --state "$HOME/wayfinding-agent.json" --no-wait
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
wayfinding list --type resource
wayfinding search "journey words"
wayfinding show <item-id>
wayfinding add --type resource --title "A useful link" --body "Notes" --tags reading,guide
wayfinding import ./notes.md
wayfinding import ./markdown-folder
wayfinding comment <item-id> "A follow-up"
wayfinding comments <item-id>
```

Markdown imports retain simple front matter fields `title`, `type` (or `itemType`), `tags` (comma-separated or inline array), `created`, `resourceKind`, and `sharedFrom`; the remaining Markdown is the body. Files must have `.md` extensions. The agent is always marked as the author, regardless of input front matter. For a directory, Markdown files are read recursively.

Each read checks the full signed journey controls and their encrypted labels. Before a write, the client checks them again and uses the compiled Bend access rules. An agent's effective access follows the adding person's current role, limited by its original approval: a read-write agent loses writes while its person is read-only, and a read-only agent never gains writes. `status` reports that current effective access. Removing the person ends their agents' access. The client also checks the required version before encrypting an item or comment locally. Server requests are signed with the method, path and query, body digest, timestamp, and fresh nonce. If access ends, the client says so and stops. Decrypted items remain in memory for the process lifetime; keys are also stored in a file only when you explicitly use `--state`.

Clients at 0.1.3 or older must update. If the required minimum rises or an unsupported control appears, CLI and MCP stop before returning content or writing. Run `npm install -g @ai-wayfinding/client@latest`, then retry with the same connection; do not request approval again. Legacy journeys were purged by server schema v2, not migrated. A live agent link shows current signed journey settings and remains read-only; its server must be updated if it cannot understand the controls.

### Optional encrypted-data cache

A remembered session uses a local cache by default. An in-memory connection uses no cache by default. Pass `--cache` to enable it for a one-shot command or `--no-cache` to disable it. Under the OS cache directory (macOS: `~/Library/Caches`; Linux: `$XDG_CACHE_HOME` or `~/.cache`; Windows: `%LOCALAPPDATA%`), the client stores **only ciphertext envelopes and the head of a freshly verified signed log**. The journey key, secret signing key, item titles, and item bodies never go to this cache. A `--state` file, when requested, is separate from this encrypted-data cache. On Unix, cache folders are 0700 and files 0600. The client refreshes records by sequence number but verifies the full signed log again before every use. Disable the cache on a shared device.

## Connect an MCP tool host

The MCP server exposes `add`, `import`, `list`, `search`, `show`, `comment`, `comments`, `status`, and `connect_status`. Tool descriptions explain that the person approves access. Standard output is reserved for MCP messages; approval instructions go to standard error. With a remembered connection, use this command without `--connect`. With an in-memory connection, give the journey ID:

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

The person manages other members and any key rotation in the browser. An agent cannot approve itself, change someone's scope, add or remove members, or rotate journey keys. If the person previously rotated the journey key, the current approval API may not provide this agent the old epoch wraps needed to verify *all* earlier history; this client stops with a missing-key message rather than writing without verification.

## Agent link (fallback)

Some agent sandboxes, for example Claude Cowork, cannot reach `app.wayfinding.support`, and many people cannot change the allowlist. If the CLI fails with exit code 5 ("Could not reach the journey server"), the agent can still read a web page with its web fetch tool. Ask the person to open their journey, go to **People & agents → Add agent by link**, choose how long the link should last (1, 7 or 30 days) and confirm with their passkey. They give you a link like `https://app.wayfinding.support/a/<secret>`. Read it with your web fetch tool; it returns JSON with the journey's items and people, in pages of under 12 KB (`page.next` holds the next page's URL).

- The link is **read-only**. To add something, give the person the text and ask them to add it in the journey.
- It is a deliberate exception to end-to-end encryption: while the link is live, Wayfinding's server decrypts the journey to answer it. Anyone with the link can read the journey until it expires or the person removes the agent.
- When `access.expiringSoon` is true, or the link answers 410, ask the person to open `access.renewUrl` and extend it with their passkey. The link stays the same.
- If the link answers 404, it has ended. Ask the person for a new one.

The CLI prints this hint after a network failure, and `--json` errors carry it in a `fallback` field.
