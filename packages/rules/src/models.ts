// Every rule model that is compiled to generated/<name>.js. The build and the
// check read this list; add a model here to ship it. One import and one key
// per line, so parallel additions merge cleanly.
import {artifact} from './artifact.ts'
import {project} from './project.ts'
import {seats} from './seats.ts'
import {task} from './task.ts'

export const models = {
  artifact,
  project,
  seats,
  task,
} as const
