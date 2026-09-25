# Journey agent client

The `wayfinding` command gives an agent access to one encrypted journey after a person approves it. It also runs a Model Context Protocol (MCP) server over standard input and output. Agents can read, add items, and comment; **they cannot change journey membership or access**. Read-only agents cannot write.

## Install

Node.js 22 or newer is required. Install both packages from the latest release:

```sh
npm install -g \
  https://github.com/AI-Wayfinding/journey/releases/download/v0.1.0/ai-wayfinding-core-0.1.0.tgz \
  https://github.com/AI-Wayfinding/journey/releases/download/v0.1.0/ai-wayfinding-client-0.1.0.tgz
wayfinding --help
```

### Build from this repository

The packages are not on npm. From a clone of this repository:

```sh
npm ci
npm run build -w packages/core
npm run build -w packages/client
npm pack -w packages/core
npm pack -w packages/client
# Install both local tarballs together. The client needs the unpublished core package.
npm install -g ./ai-wayfinding-core-0.1.0.tgz ./ai-wayfinding-client-0.1.0.tgz
wayfinding --help
```

If a global install is not wanted, run `node packages/client/dist/cli.js --help` from the clone after building. A GitHub URL is not a reliable npm install target for one package inside this workspace; installing the root does not install the client binary. The two local tarballs are the supported install path for now. The client uses the MCP SDK version 1.30.1; no other direct runtime dependency is added.

## Connect to a journey

```sh
wayfinding connect <journey-id> --scope read
wayfinding connect <journey-id> --scope readwrite --remember
```

The journey server defaults to `https://app.wayfinding.support`; use `--server https://your-server` if needed. The command creates a new age encryption identity and signing key **in memory**, asks the server for approval, and prints a link and a six-digit code. Open the link in your browser, check that the code matches, choose the approved access and time, then confirm with your passkey. The command waits until approval, expiry, or lockout. Approval is valid for at most 8 hours without remembering, or 90 days when remembered. The person must choose remembered access in the approval screen before keys are saved; the client refuses expired keys.

Without `--remember`, the one-shot `connect` command does not save keys. It closes the connection when it exits. Start `wayfinding mcp --connect <journey-id>` to keep an in-memory connection for that MCP process, or pass `--journey <journey-id>` to an individual CLI command to ask for fresh approval on each invocation. There is no background daemon and no invisible persistent login.

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

Each read checks the full signed journey membership log. Before a write, the client checks that log again, confirms this agent is still an active read-write member and that its version meets the journey minimum, then encrypts the item or comment locally. Server requests are signed with the method, path and query, body digest, timestamp, and fresh nonce. If access ends, the client says so and stops. Keys and decrypted items remain in memory for the process lifetime.

### Optional encrypted-data cache

A remembered session uses a local cache by default. An in-memory connection uses no cache by default. Pass `--cache` to enable it for a one-shot command or `--no-cache` to disable it. Under the OS cache directory (macOS: `~/Library/Caches`; Linux: `$XDG_CACHE_HOME` or `~/.cache`; Windows: `%LOCALAPPDATA%`), the client stores **only ciphertext envelopes and the head of a freshly verified signed log**. The journey key, secret signing key, item titles, and item bodies never go to this cache. On Unix, cache folders are 0700 and files 0600. The client refreshes records by sequence number but verifies the full signed log again before every use. Disable the cache on a shared device.

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

For Claude Desktop, add the `mcpServers.wayfinding` entry to its MCP configuration. For Claude Code, use `claude mcp add wayfinding -- wayfinding mcp --connect YOUR_JOURNEY_ID`. For Codex, use `codex mcp add wayfinding -- wayfinding mcp --connect YOUR_JOURNEY_ID`. Use the absolute path to the built `cli.js` with `node` if `wayfinding` is not on the host's PATH. When the MCP process begins, the person sees the link and code in the host's standard-error log; approve it before the MCP connection finishes. Some hosts hide stderr: run `wayfinding connect <journey-id> --remember` in a terminal first, then configure `wayfinding mcp` without `--connect`.

The person manages other members and any key rotation in the browser. An agent cannot approve itself, change someone's scope, add or remove members, or rotate journey keys. If the person previously rotated the journey key, the current approval API may not provide this agent the old epoch wraps needed to verify *all* earlier history; this client stops with a missing-key message rather than writing without verification.
