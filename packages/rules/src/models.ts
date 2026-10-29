// Every rule model that is compiled to generated/<name>.js. The build and the
// check read this list; add a model here to ship it.
import {seats} from './seats.ts'
import {personalGroup} from './personalGroup.ts'
import {transfer} from './transfer.ts'

export const models = {
  seats,
  personalGroup,
  transfer,
} as const
