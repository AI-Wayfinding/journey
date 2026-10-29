// Every rule model that is compiled to generated/<name>.js. The build and the
// check read this list; add a model here to ship it. One import and one key
// per line, so parallel additions merge cleanly.
import {artifact} from './artifact.ts'
import {personalGroup} from './personalGroup.ts'
import {project} from './project.ts'
import {seats} from './seats.ts'
import {task} from './task.ts'
import {transfer} from './transfer.ts'

export const models = {
  artifact,
  personalGroup,
  project,
  seats,
  task,
  transfer,
} as const
