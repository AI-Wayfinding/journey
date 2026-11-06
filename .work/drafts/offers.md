# Agent offers

Status: draft design, approved in direction by Dan (offer model). Build starts after the OAuth AS branch (`feat/oauth-as`) merges, because offers extend the agent card and console agent pages that branch rewrites.

## Problem

A journey member can see which agents exist and what they may do (the card's capabilities), but not what work an agent will take on. Tasks exist (`packages/rules/src/task.ts`, `task_create`, `task_step`) but nobody can address one to an agent for a named kind of work with checked input.

## Model

An **offer** is a named kind of work an agent advertises. It lives on the agent, next to the card.

```
Offer {
  id: string            // slug, unique per agent
  name: string          // max 60
  description: string   // max 1000, plain text
  tags: string[]        // free labels, max 10
  examples: string[]    // example requests, max 5
  inputSchema: JSONSchema   // object schema, max 16 KiB
  outputSchema?: JSONSchema // optional, max 16 KiB
  journeys: 'all' | JourneyId[] // where it is visible; default: the agent's journeys
}
```

Fields follow A2A AgentSkill (id, name, description, tags, examples) so an A2A card can be projected later; schemas replace A2A's input/output modes because MCP tools already speak JSON Schema.

## Rules

1. Only the agent's owner (the person) edits offers, in the console or with `offer_set` / `offer_remove`. An agent may edit its own offers only if its card holds the new account capability `offer.manage`.
2. Editing offers never widens the card, so it needs no passkey.
3. An offer is visible in a journey only while the agent is a live member there and its card holds `task.manage`. Removing the agent hides every offer.
4. `task_create` gains optional `{agentId, offerId, input}`. The host checks: the offer is visible in the journey, `input` validates against `inputSchema`, the caller holds `task.manage` in the journey. The task is created and claimed for the agent in one host step (two rule steps: create by caller, claim by agent).
5. The agent reports a result with `task_step finish` plus `output`; when the offer has `outputSchema`, output must validate or the step is refused and state is unchanged.
6. A refused call leaves state unchanged (existing invariant).

## Status mapping (MCP Tasks extension)

| Task rule status | MCP Tasks status |
|---|---|
| open, claimed, inRound | working |
| needsInput (new) | input_required |
| done | completed |
| expired | failed |
| cancelled | cancelled |

The task rule gains `askInput` (claimant, from claimed or inRound -> needsInput) and `answer` (creator, needsInput -> claimed). Laws: needsInput uses no extra round; only the creator answers; finished tasks never change (existing step law covers it).

## Admission

Each offer has an admission policy: an ordered rule list, first match wins, then a default.

```
admission: { rules: [{ who, journeys?, decision: 'allow'|'hold'|'deny', limit?: {count, per: 'hour'|'day'|'week'} }], default: 'hold' }
who: 'owner'|'guide'|'members'|'people'|'agents'|{person}|{agent}
```

- allow: task created and claimed for the agent at once. A rule with `limit` allows only within the requester's count for the period; past it the request is held, never denied.
- hold: task enters `requested` until approve or decline.
- deny: refused; no task or record; requester sees only "not accepted".

Presets at offer creation: Open (allow members), Members (allow people, hold agents; default), Ask me (hold all but owner), Custom.

Deciders: the owner, or the agent when its card holds `offer.decide`. No passkey (does not widen the card). Approve may add "always allow <requester>" as an allow rule.

Task rule additions: status `requested` (before open) and final `declined`; ops `approve` (decider -> claimed for agent), `decline` (decider -> declined, optional reason); requester may cancel while requested; `expire` applies at the deadline. Host passes `withinLimit` and `isDecider` as inputs. Laws: a requested task reaches claimed only by approve; held requests use no rounds; declined is final.

MCP Tasks mapping: requested -> working (message "awaiting approval by <owner>"); declined -> failed with reason.

Visibility: held requests visible only to requester, owner and deciders.

## Discovery

`offer_search {journeyId, query?, tags?}` lists visible offers across member agents, with agent name and owner. Library-style FTS is not needed at PoC scale; filter in the Journey DO.

## UI

- Console agent page: Offers section (add, edit, remove; schema as JSON textarea with validation).
- MCP app agent view: offer chips on each agent card; "Ask this agent" form generated from `inputSchema` (string, number, boolean, enum, text area for long strings; raw JSON fallback).
- Task view shows offer name, input, status, output.

## Out of scope

- A2A wire protocol and public agent-card.json.
- MCP Skills extension (SEP-2640): distributes skill files, not callable services.
- Payment, quotas, scheduling.

## Checks

- Rules: task rule laws for needsInput/answer with bug variants that the gate must catch.
- MCP tests: invalid input refused, unchanged state; offer of removed agent invisible; output schema enforced; non-owner cannot edit offers; agent without `offer.manage` cannot edit its own offers.
