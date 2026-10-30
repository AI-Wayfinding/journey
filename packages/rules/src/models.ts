// Every rule model that is compiled to generated/<name>.js. The build and the
// check read this list; add a model here to ship it. One import and one key
// per line, so parallel additions merge cleanly.
import {agentCard} from './agentCard.ts'
import {artifact} from './artifact.ts'
import {binding} from './binding.ts'
import {board} from './board.ts'
import {card} from './card.ts'
import {grant} from './grant.ts'
import {item} from './item.ts'
import {journey} from './journey.ts'
import {personalGroup} from './personalGroup.ts'
import {post} from './post.ts'
import {project} from './project.ts'
import {round} from './round.ts'
import {seats} from './seats.ts'
import {task} from './task.ts'
import {topic} from './topic.ts'
import {transfer} from './transfer.ts'

export const models = {
  agentCard,
  artifact,
  binding,
  board,
  card,
  grant,
  item,
  journey,
  personalGroup,
  post,
  project,
  round,
  seats,
  task,
  topic,
  transfer,
} as const
