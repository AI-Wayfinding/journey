// Every rule model that is compiled to generated/<name>.js. The build and the
// check read this list; add a model here to ship it.
import {seats} from './seats.ts'
import {journey} from './journey.ts'
import {agentCard} from './agentCard.ts'
import {grant} from './grant.ts'

export const models = {
  seats,
  journey,
  agentCard,
  grant,
} as const
