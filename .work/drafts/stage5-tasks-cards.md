# Stage 5: tasks and agent cards

## Summary <!-- work:summary -->
Make tasks and agent cards usable by agents. A person's agent can see its effective capabilities, find tasks addressed to it in an inbox resource, claim one, work through rounds and finish; the server ends a task at its round cap or deadline. Clients that declare the MCP Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663) can also get, update and cancel a Wayfinding task through `tasks/get`, `tasks/update` and `tasks/cancel`.

## Why <!-- work:rationale -->
Design decisions 9 to 11 and research lane C: MCP Tasks are request handles, not an assignable work queue, so the server keeps its own task store (already stepped by the compiled `task` rule from stage 2) and exposes an inbox resource plus subscriptions; offline agents poll. A person signs their agent's card limits once; the agent's effective capability at each use is the person's live capability AND the card limit AND the agent being live (D45); agents cannot issue grants (no re-delegation in v1). Error code for a missing client capability follows the 2026-07-28 core schema, `-32021` (design Q8), not SEP-2663's `-32003`. The SDK 2.4.0 does not implement the Tasks extension, so the handlers are custom, durable before reply, use unguessable ids, and answer only when the request's client declared the extension. Task deadlines are checked with the server clock at every step and by a Durable Object alarm. Hard constraints: no `gate()` or `compiled()` in server source, values below 2^53, exact pins, MCP SDK 2.4.0.

## Open decisions <!-- work:decisions -->

## Acceptance criteria <!-- work:criteria -->
- tasks-cards: A task created by one member and claimed by an agent moves through rounds and ends at the round cap and, separately, at the deadline; Tasks extension calls work only when declared and errors use code -32021; an agent's effective capability never exceeds its person's live capability or its signed card limit, and an agent cannot issue a grant.
