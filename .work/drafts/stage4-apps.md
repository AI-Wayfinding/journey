# Stage 4: MCP Apps views

## Summary <!-- work:summary -->
Add MCP Apps views to the Wayfinding MCP server so a person in an Apps-capable host (Claude, ChatGPT, VS Code) sees and works with their journeys in the chat: a journey overview (members, roles, guides, agents, projects, joining policy, invites), a project view, and an artifact list (names, sizes, versions only). Views act only through tools, open the Wayfinding sign-in page for passkey actions, and show a notice that the conversation goes to the person's AI provider.

## Why <!-- work:rationale -->
Design decision 1: MCP plus MCP Apps is the human UI; the only web pages are sign-in and consent. Built on the official `@modelcontextprotocol/ext-apps` 2.0.4 (`registerAppTool`, `registerAppResource`, `RESOURCE_MIME_TYPE` from `@modelcontextprotocol/ext-apps/server`; the `App` class in views). Views are self-contained HTML (inline script and style; no external fetch, so the default restrictive CSP holds) built at build time into a generated module the Worker imports, so the Worker needs no filesystem. URIs are versioned (`ui://wayfinding/v1/journey.html`); a view keeps loading after a newer version ships because the server keeps serving every released URI. App-only tools (visibility `["app"]`) serve refresh and form actions. Passkey or step-up actions call `ui/open-link` to `https://poc.wayfinding.support/signin`, a Worker route that redirects to AuthKit hosted sign-in. Artifact content is never shown in a view: views run in the AI host, which is a cloud client and gets metadata only (decision 5). Hard constraints: exact pins, no `node:` imports in Worker code, no real confidential data, MCP SDK 2.4.0.

## Open decisions <!-- work:decisions -->

## Acceptance criteria <!-- work:criteria -->
- apps: In an MCP Apps host test harness, every view loads from a versioned `ui://` URI, performs its actions only through tools, opens the sign-in page for passkey actions, and shows the model-provider notice; a view built for an older version still loads.
