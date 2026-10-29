// Host encoders for the shipped rule modules in generated/.
//
// The Worker and the local proxy step the generated modules with plain
// numbers. These encoders turn named values into those numbers, in the order
// each model declares them, and refuse anything that is not a natural below
// 2^53 before a step runs. They import nothing, so they ship in the Worker
// without gdp-wired; a test checks them against each model's encodeInput.

export const JOURNEY = {
  op: ['found', 'policy', 'invite', 'request', 'join', 'admit', 'refuse', 'role', 'guide', 'unguide', 'addAgent', 'remove', 'leave', 'check'],
  role: ['read', 'write'],
  policy: ['request', 'open', 'invite'],
  pending: ['none', 'invited', 'requested'],
  kind: ['none', 'person', 'agent'],
  need: ['read', 'write', 'guide'],
} as const

export const PROJECT = {
  op: ['create', 'join', 'leave', 'setPurpose', 'setStatus'],
  status: ['gettingStarted', 'active', 'lookingForOthers', 'archived'],
} as const

export const AGENT_CARD = {
  op: ['sign', 'edit', 'withdraw', 'check'],
  need: ['read', 'write', 'grant'],
} as const

export const GRANT = {
  op: ['issue', 'use', 'revoke', 'end'],
  status: ['unissued', 'live', 'revoked', 'ended'],
} as const

export type JourneyOp = (typeof JOURNEY.op)[number]
export type Role = (typeof JOURNEY.role)[number]
export type Policy = (typeof JOURNEY.policy)[number]
export type Pending = (typeof JOURNEY.pending)[number]
export type Kind = (typeof JOURNEY.kind)[number]
export type JourneyNeed = (typeof JOURNEY.need)[number]
export type ProjectOp = (typeof PROJECT.op)[number]
export type ProjectStatus = (typeof PROJECT.status)[number]
export type AgentCardOp = (typeof AGENT_CARD.op)[number]
export type CardNeed = (typeof AGENT_CARD.need)[number]
export type GrantOp = (typeof GRANT.op)[number]
export type GrantStatus = (typeof GRANT.status)[number]

/** A natural below 2^53, or a RangeError. */
export function natural(value: number, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a natural below 2^53, not ${value}`)
  }
  return value
}

/** The position of `value` in `table`, as the model numbers its choices. */
export function encodeChoice<T extends readonly string[]>(table: T, value: T[number], what: string): number {
  const index = table.indexOf(value)
  if (index < 0) throw new RangeError(`${what} must be one of ${table.join(', ')}, not ${String(value)}`)
  return index
}

/** The named choice at `index` in `table`, or a RangeError for a number the model never produces. */
export function decodeChoice<T extends readonly string[]>(table: T, index: number, what: string): T[number] {
  const value = table[index]
  if (value === undefined) throw new RangeError(`${what} has no choice numbered ${index}`)
  return value
}

const bit = (value: boolean): number => (value ? 1 : 0)

export interface JourneyInput {
  op: JourneyOp
  actor: number
  subject?: number
  role?: Role
  newPolicy?: Policy
  need?: JourneyNeed
}

/** One journey request. `subject` defaults to the actor; unused choices default to their first value. */
export function encodeJourney(input: JourneyInput): Record<string, number> {
  return {
    op: encodeChoice(JOURNEY.op, input.op, 'journey op'),
    actor: natural(input.actor, 'journey actor'),
    subject: natural(input.subject ?? input.actor, 'journey subject'),
    role: encodeChoice(JOURNEY.role, input.role ?? 'read', 'journey role'),
    newPolicy: encodeChoice(JOURNEY.policy, input.newPolicy ?? 'request', 'journey policy'),
    need: encodeChoice(JOURNEY.need, input.need ?? 'read', 'journey need'),
  }
}

export interface ProjectInput {
  op: ProjectOp
  actor: number
  actorIsLive: boolean
  to?: ProjectStatus
}

export function encodeProject(input: ProjectInput): Record<string, number> {
  return {
    op: encodeChoice(PROJECT.op, input.op, 'project op'),
    actor: natural(input.actor, 'project actor'),
    actorIsLive: bit(input.actorIsLive),
    to: encodeChoice(PROJECT.status, input.to ?? 'gettingStarted', 'project status'),
  }
}

export interface AgentCardInput {
  op: AgentCardOp
  newRead?: boolean
  newWrite?: boolean
  newGrant?: boolean
  personSigned?: boolean
  need?: CardNeed
  personHas?: boolean
  personLive?: boolean
  agentLive?: boolean
}

export function encodeAgentCard(input: AgentCardInput): Record<string, number> {
  return {
    op: encodeChoice(AGENT_CARD.op, input.op, 'agent card op'),
    newRead: bit(input.newRead ?? false),
    newWrite: bit(input.newWrite ?? false),
    newGrant: bit(input.newGrant ?? false),
    personSigned: bit(input.personSigned ?? false),
    need: encodeChoice(AGENT_CARD.need, input.need ?? 'read', 'agent card need'),
    personHas: bit(input.personHas ?? false),
    personLive: bit(input.personLive ?? false),
    agentLive: bit(input.agentLive ?? false),
  }
}

export interface GrantInput {
  op: GrantOp
  actor: number
  grantee?: number
  command?: number
  resource?: number
  uses?: number
  actorLive?: boolean
  actorIsAgent?: boolean
  actorIsGuide?: boolean
  grantorHolds?: boolean
  fromGrant?: boolean
  grantorLive?: boolean
  granteeLive?: boolean
  expired?: boolean
}

export function encodeGrant(input: GrantInput): Record<string, number> {
  return {
    op: encodeChoice(GRANT.op, input.op, 'grant op'),
    actor: natural(input.actor, 'grant actor'),
    grantee: natural(input.grantee ?? 0, 'grant grantee'),
    command: natural(input.command ?? 0, 'grant command'),
    resource: natural(input.resource ?? 0, 'grant resource'),
    uses: natural(input.uses ?? 0, 'grant uses'),
    actorLive: bit(input.actorLive ?? false),
    actorIsAgent: bit(input.actorIsAgent ?? false),
    actorIsGuide: bit(input.actorIsGuide ?? false),
    grantorHolds: bit(input.grantorHolds ?? false),
    fromGrant: bit(input.fromGrant ?? false),
    grantorLive: bit(input.grantorLive ?? false),
    granteeLive: bit(input.granteeLive ?? false),
    expired: bit(input.expired ?? false),
  }
}
