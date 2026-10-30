import { Refused, type Command, type ToolData } from './commands.ts';
import { roundInputs, roundStatuses } from './round-inputs.ts';
import { roundRule, scalar, cell, sameState, type Snapshot } from './rules.ts';
import { library, isLibraryArtifact, requireItem, readableItem, itemMetadata, type LibraryArtifact, type LibraryAccess } from './library.ts';
import { libraryInputs, serverTextLimit } from './library-inputs.ts';
import { attachRoundConversation, type ForumState } from './forum.ts';
import { firstPosition } from './guidance/first-position.ts';
import type { KeyValueStorage } from './storage.ts';

interface Interview { person: number; itemId?: string; chunks: number; version: number }
export interface SensemakingRound {
  id: string; title: string; goal: string; format: string; guidanceItemId: string; documentItemId: string;
  relatedItemIds: string[]; previousRoundId?: string; conversationId: string; rule: Snapshot; interviews: Interview[];
}
interface RoundState extends ForumState { membership: Snapshot; rounds: SensemakingRound[] }
export interface RoundAccess { person: number; actor: number; agent: boolean; read: boolean; create: boolean; run: boolean; contribute: boolean }
export type RoundCommand = Extract<Command, { tool: keyof typeof roundInputs }>;
export function isRoundCommand(command: Command): command is RoundCommand { return Object.hasOwn(roundInputs, command.tool); }
export function roundJourney(roundId: string): string {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const match = new RegExp(`^round_(${uuid})_${uuid}$`).exec(roundId);
  if (!match) throw new Refused('Invalid round id');
  return `journey_${match[1]}`;
}
function requireCap(value: boolean, name: string): void { if (!value) throw new Refused(`Sensemaking ${name} capability refused`); }
function livePerson(state: RoundState, person: number): boolean { return person > 0 && cell(state.membership, 'Members', person) === 1; }
function personSlot(state: RoundState, personId: string): number {
  const slot = state.identities.findIndex(p => p.id === personId) + 1;
  if (!livePerson(state, slot)) throw new Refused('Round participant must be a live person member');
  return slot;
}
function capacity(value: number): void { if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new Refused('Round counter capacity reached'); }
function step(round: SensemakingRound, op: number, access: RoundAccess, subject = access.person, to = 0, subjectLive = false): void {
  const before = round.rule;
  const after = roundRule.step(before, { op, actor: access.person, subject, to, canCreate: +access.create, canRun: +access.run, canContribute: +access.contribute, subjectLive: +subjectLive });
  if (sameState(before, after)) throw new Refused('Round change refused by coordination rules');
  round.rule = after;
}
function facilitates(round: SensemakingRound, access: RoundAccess): void {
  requireCap(access.run && scalar(round.rule, 'facilitator') === access.person, 'facilitator round.run');
}
function participant(round: SensemakingRound, person: number): void {
  if (cell(round.rule, 'Participants', person) !== 1) throw new Refused('Only round participants may write interviews');
}
function artifact(state: RoundState, itemId: string): LibraryArtifact | undefined {
  const item = state.artifacts.find(a => a.id === itemId); return item && isLibraryArtifact(item) ? item : undefined;
}
function sharedArtifact(state: RoundState, itemId: string, person: number, text = false): LibraryArtifact {
  const item = artifact(state, itemId); requireItem(item, person, true);
  if (scalar(item.rule, 'visibility') !== 0 || (text && (item.storage !== 'server' || item.url !== undefined))) throw new Refused('Round guidance and document require shared server text; related items must be shared');
  return item;
}
function libraryAccess(person: number, write = false): LibraryAccess { return { person, read: true, write, delete: false, guide: false }; }
function summary(state: RoundState, round: SensemakingRound): ToolData {
  return { journeyId: state.id, roundId: round.id, title: round.title, goal: round.goal, format: round.format,
    facilitator: state.identities[scalar(round.rule, 'facilitator') - 1]?.id, status: roundStatuses[scalar(round.rule, 'status')],
    previousRoundId: round.previousRoundId, contributions: scalar(round.rule, 'contributions'), conversationId: round.conversationId };
}
async function view(state: RoundState, round: SensemakingRound, access: RoundAccess, storage: KeyValueStorage): Promise<ToolData> {
  const get = async (itemId: string): Promise<ToolData | undefined> => {
    const item = artifact(state, itemId); if (!item || !readableItem(item, access.person, access.read)) return undefined;
    return (await library(state, { tool: 'library_get', input: { itemId } }, libraryAccess(access.person), storage)).data;
  };
  const related: ToolData[] = [];
  for (const itemId of round.relatedItemIds) {
    const item = artifact(state, itemId); if (item && readableItem(item, access.person, access.read)) related.push(itemMetadata(state, item));
  }
  return { ...summary(state, round), guidance: await get(round.guidanceItemId), document: await get(round.documentItemId), related,
    participants: state.identities.flatMap((p, index) => cell(round.rule, 'Participants', index + 1) === 1 ? [{ personId: p.id, live: livePerson(state, index + 1), interviewShared: cell(round.rule, 'Shared', index + 1) === 1 }] : []),
    contributionSummary: state.identities.flatMap((p, index) => { const count = cell(round.rule, 'Contributions', index + 1); return count ? [{ personId: p.id, count }] : []; }),
    conversation: { topicId: round.conversationId, target: { roundId: round.id } },
    privacyNotice: 'Proof of concept: the server can read interview notes, contributions and library text. Use synthetic data only.' };
}
function interviewKey(round: SensemakingRound, interview: Interview, chunk: number): string { return JSON.stringify(['roundInterview', round.id, interview.person, interview.version, chunk]); }
async function notes(round: SensemakingRound, interview: Interview | undefined, storage: KeyValueStorage): Promise<string> {
  if (!interview) return '';
  let text = '';
  for (let i = 0; i < interview.chunks; i++) {
    const raw = await storage.get(interviewKey(round, interview, i));
    const chunk: unknown = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    if (typeof chunk !== 'string') throw new Refused('Interview content unavailable'); text += chunk;
  }
  return text;
}
function writeNotes(round: SensemakingRound, person: number, text: string, writes: [string, string][], itemId?: string): Interview {
  let interview = round.interviews.find(i => i.person === person);
  if (!interview) { interview = { person, chunks: 0, version: 0 }; round.interviews.push(interview); }
  capacity(interview.version);
  for (let i = 0; i < interview.chunks; i++) writes.push([interviewKey(round, interview, i), 'null']);
  interview.version++; interview.chunks = 0;
  if (itemId !== undefined) interview.itemId = itemId;
  for (let i = 0; i < text.length; i += 8192) writes.push([interviewKey(round, interview, interview.chunks++), JSON.stringify(text.slice(i, i + 8192))]);
  return interview;
}

/** Runs in the journey's serialized turn. All item versions, interview chunks and rule steps commit together. */
export async function rounds(state: RoundState, command: RoundCommand, access: RoundAccess, storage: KeyValueStorage, now: number): Promise<{ data: ToolData; changed: boolean; writes: [string, string][] }> {
  if (!livePerson(state, access.person)) throw new Refused('A live journey person is required');
  const writes: [string, string][] = [];
  if (command.tool === 'round_list') {
    requireCap(access.read, 'read'); return { data: { journeyId: state.id, rounds: state.rounds.map(r => summary(state, r)) }, changed: false, writes };
  }
  const roundId = 'roundId' in command.input ? command.input.roundId : undefined;
  let round = roundId === undefined ? undefined : state.rounds.find(r => r.id === roundId);
  if (command.tool !== 'round_create' && !round) throw new Refused('Round not found');
  if (command.tool === 'round_create' || command.tool === 'round_next') {
    requireCap(access.create, 'round.create');
    const i = command.input;
    if (round) { facilitates(round, access); if (scalar(round.rule, 'status') !== 3) throw new Refused('Only a closed round starts its successor'); }
    const previousRoundId = round?.id;
    const people = command.tool === 'round_create' && command.input.participants !== undefined ? [...new Set(command.input.participants)].map(p => personSlot(state, p))
      : state.identities.flatMap((_, index) => livePerson(state, index + 1) ? [index + 1] : []);
    const supplied = command.tool === 'round_create' ? command.input : undefined;
    if (supplied?.guidanceItemId) sharedArtifact(state, supplied.guidanceItemId, access.person, true);
    if (supplied?.documentItemId) sharedArtifact(state, supplied.documentItemId, access.person, true);
    const relatedItemIds = [...new Set(supplied?.relatedItemIds ?? [])];
    for (const itemId of relatedItemIds) sharedArtifact(state, itemId, access.person);
    // round.create authorizes only these scoped defaults, never arbitrary library operations.
    const add = async (name: string, kind: 'prompt' | 'markdown', text: string): Promise<string> => {
      const result = await library(state, { tool: 'library_add', input: libraryInputs.library_add.parse({ name, kind, text, journeyId: state.id }) }, libraryAccess(access.person, true), storage);
      writes.push(...result.writes); return String(result.data.itemId);
    };
    const guidanceItemId = supplied?.guidanceItemId ?? await add('First position interview', 'prompt', firstPosition);
    const documentItemId = supplied?.documentItemId ?? await add(`${i.title} - sensemaking`, 'markdown', `# ${i.title}\n\nGoal: ${i.goal}\n\n## Contribution instructions\n\nYour own agent helps integrate the findings you choose to share. Use round_contribute while open or synthesising. Each section is attributed to the person. Keep quotes distinct from interpretation; include tensions and questions rather than forcing consensus. Private interviews stay private until explicitly shared.\n`);
    round = { id: `round_${state.id.slice('journey_'.length)}_${crypto.randomUUID()}`, title: i.title, goal: i.goal, format: i.format ?? 'first-position', guidanceItemId, documentItemId, relatedItemIds, previousRoundId, conversationId: '', rule: roundRule.init(), interviews: [] };
    step(round, 0, access);
    // Creation's default participants are its own scoped effect, even for a create-only agent.
    for (const person of people) step(round, 2, { ...access, run: true }, person, 0, true);
    state.rounds.push(round);
    round.conversationId = attachRoundConversation(state, round.id, round.title, access.person, now).id;
    return { data: summary(state, round), changed: true, writes };
  }
  if (!round) throw new Refused('Round not found');
  if (command.tool === 'round_read') { requireCap(access.read, 'read'); return { data: await view(state, round, access, storage), changed: false, writes }; }
  if (command.tool === 'interview_read') {
    requireCap(access.read, 'read');
    const person = command.input.personId === undefined ? access.person : state.identities.findIndex(p => p.id === command.input.personId) + 1;
    if (!person || (person !== access.person && cell(round.rule, 'Shared', person) !== 1)) throw new Refused('Interview is private to its participant');
    const interview = round.interviews.find(i => i.person === person);
    return { data: { roundId: round.id, personId: state.identities[person - 1]?.id, label: `Interview — ${state.identities[person - 1]?.id}`, shared: cell(round.rule, 'Shared', person) === 1, itemId: interview?.itemId, text: await notes(round, interview, storage) }, changed: false, writes };
  }
  if (command.tool === 'round_status') { facilitates(round, access); step(round, 1, access, access.person, roundStatuses.indexOf(command.input.to)); }
  else if (command.tool === 'round_participants') {
    facilitates(round, access);
    for (const personId of new Set(command.input.add ?? [])) { const person = personSlot(state, personId); if (!cell(round.rule, 'Participants', person)) step(round, 2, access, person, 0, true); }
    for (const personId of new Set(command.input.remove ?? [])) {
      const person = state.identities.findIndex(p => p.id === personId) + 1;
      if (!person) throw new Refused('Unknown round participant');
      if (cell(round.rule, 'Participants', person)) step(round, 3, access, person);
    }
  } else if (command.tool === 'interview_assign') {
    facilitates(round, access); requireCap(access.read, 'read');
    const person = personSlot(state, command.input.personId); participant(round, person);
    if (round.interviews.some(i => i.person === person) || cell(round.rule, 'Shared', person)) throw new Refused('Facilitator cannot replace an existing or shared interview');
    const item = artifact(state, command.input.itemId); requireItem(item, access.person, access.read); requireItem(item, person, true);
    if (item.storage !== 'server' || item.url !== undefined) throw new Refused('Interview assignment needs a server text artifact');
    const result = await library(state, { tool: 'library_get', input: { itemId: item.id } }, libraryAccess(access.person), storage);
    if (typeof result.data.text !== 'string') throw new Refused('Interview source text unavailable');
    writeNotes(round, person, result.data.text, writes, item.id);
  } else if (command.tool === 'interview_write') {
    requireCap(access.contribute, 'round.contribute'); participant(round, access.person);
    writeNotes(round, access.person, command.input.text, writes);
  } else if (command.tool === 'interview_share') {
    requireCap(access.contribute, 'round.contribute'); participant(round, access.person);
    if (!cell(round.rule, 'Shared', access.person)) step(round, 4, access);
  } else if (command.tool === 'round_contribute') {
    requireCap(access.contribute, 'round.contribute'); capacity(scalar(round.rule, 'contributions')); capacity(cell(round.rule, 'Contributions', access.person));
    step(round, 5, access);
    const item = sharedArtifact(state, round.documentItemId, access.person, true);
    const data = (await library(state, { tool: 'library_get', input: { itemId: item.id } }, libraryAccess(access.person), storage)).data;
    if (typeof data.text !== 'string') throw new Refused('Round document text unavailable');
    const text = `${data.text}\n\n## Contribution ${scalar(round.rule, 'contributions')} — ${state.identities[access.person - 1]?.id}\n\n${command.input.text}\n`;
    if (new TextEncoder().encode(text).length > serverTextLimit) throw new Refused('Round document exceeds 256 KiB');
    // Only this append is delegated by the round rule. No artifact.write capability is granted.
    const result = await library(state, { tool: 'library_version', input: { itemId: item.id, baseVersion: scalar(item.rule, 'version'), text } }, libraryAccess(access.person, true), storage);
    writes.push(...result.writes);
  }
  return { data: { ...summary(state, round), accepted: true, personId: state.identities[access.person - 1]?.id }, changed: true, writes };
}
