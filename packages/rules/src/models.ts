// Every rule model that is compiled to generated/<name>.js. The build and the
// check read this list; add a model here to ship it. One import and one key
// per line, so parallel additions merge cleanly.
import {agentCard} from './agentCard.ts'
import {artifact} from './artifact.ts'
import {grant} from './grant.ts'
import {journey} from './journey.ts'
import {personalGroup} from './personalGroup.ts'
import {project} from './project.ts'
import {seats} from './seats.ts'
import {task} from './task.ts'
import {transfer} from './transfer.ts'

export const models = {
  agentCard,
  artifact,
  grant,
  journey,
  personalGroup,
  project,
  seats,
  task,
  transfer,
} as const
