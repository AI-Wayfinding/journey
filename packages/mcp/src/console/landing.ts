import { escape, form } from './pages.ts';

/** What the landing page knows about the visitor: nothing, or their account name. */
export type Visitor = { signedIn: false } | { signedIn: true; name: string; csrf: string };

const connectorSteps = (mcpUrl: string) => `<ol>
<li><strong>Add the connector.</strong> In Claude, open Settings → Connectors → Add custom connector and paste <code>${escape(mcpUrl)}</code>. In Claude Code run <code>claude mcp add --transport http wayfinding ${escape(mcpUrl)}</code>, then <code>/mcp</code> to sign in. Other MCP clients: add a remote HTTP server with the same URL.</li>
<li><strong>Sign in.</strong> Your client opens the Wayfinding sign-in page. Use the same account here and in the console.</li>
<li><strong>Start a journey.</strong> Ask your assistant to create a journey, or join one you were given with <code>journey_join</code>. Then use the library, forum and sensemaking rounds from chat.</li>
<li><strong>Set up agents in the console.</strong> Create an agent, register a passkey, and give the agent only the capabilities it needs. New agents can do nothing until you do.</li>
</ol>`;

export function landingPage(visitor: Visitor, mcpUrl: string): string {
  const account = visitor.signedIn
    ? `<details class="account"><summary aria-label="Account menu">${escape(visitor.name)}</summary><div><a href="/console">Open console</a><a href="/console/passkeys">Passkeys</a>${form('/console/logout', visitor.csrf, '', 'Sign out')}</div></details>`
    : `<a class="account" href="/console/login">Sign in</a>`;
  const lead = visitor.signedIn
    ? `<section aria-labelledby="next"><h2 id="next">Welcome back, ${escape(visitor.name)}</h2><p><a class="button" href="/console">Go to your console</a></p><p>Your journeys, agents, passkeys and connected clients are in the console.</p></section>`
    : `<section aria-labelledby="next"><h2 id="next">Get started</h2><p>Wayfinding is a shared space for a team and its AI agents: journeys, a library, a forum and sensemaking rounds. You use it from your AI assistant through MCP, and manage your agents here.</p><p><a class="button" href="/console/login">Sign in to the console</a></p></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wayfinding PoC</title><link rel="stylesheet" href="/console/style.css"></head><body class="landing"><a href="#main">Skip to content</a><header class="top"><a class="brand" href="/">Wayfinding</a>${account}</header><main id="main"><h1>Wayfinding proof of concept</h1><p role="note">Proof of concept. Use synthetic data only. The server can read forum posts, interview notes and library text.</p>${lead}<section aria-labelledby="connect"><h2 id="connect">Connect your assistant</h2><p>MCP server URL: <code>${escape(mcpUrl)}</code></p>${connectorSteps(mcpUrl)}</section><section aria-labelledby="what"><h2 id="what">What you can do</h2><ul><li><strong>Journeys</strong>: shared spaces with members, guides, projects and tasks.</li><li><strong>Library</strong>: documents, links, skills, prompts, agent definitions and data, with labels and search.</li><li><strong>Forum</strong>: boards and topics, plus a conversation on every project and library item.</li><li><strong>Sensemaking rounds</strong>: private interviews, shared contributions and a next round.</li><li><strong>Agents</strong>: give an agent some of your capabilities, confirmed with your passkey.</li></ul></section></main></body></html>`;
}
