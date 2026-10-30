// The shipped rule modules, stepped by the host. Only the generated modules
// from packages/rules/generated run here: never the gdp-wired interpreter.
import * as journeyModule from '../../rules/generated/journey.js';
import * as projectModule from '../../rules/generated/project.js';
import * as cardModule from '../../rules/generated/card.js';
import * as bindingModule from '../../rules/generated/binding.js';
import * as topicModule from '../../rules/generated/topic.js';
import * as postModule from '../../rules/generated/post.js';
import * as grantModule from '../../rules/generated/grant.js';
import * as artifactModule from '../../rules/generated/artifact.js';
import * as taskModule from '../../rules/generated/task.js';
import * as groupModule from '../../rules/generated/personalGroup.js';
import lock from '../../rules/rules.lock.json' with { type: 'json' };

type State = ReturnType<typeof journeyModule.init>;

interface Machine {
  init(params: object): State;
  step(params: object, state: State, input: object): State;
}

/**
 * The hashes, from `rules.lock.json`, of the rule modules this build steps.
 * Every stored journey records the stamp it was written under; the host
 * refuses to step state written under another one.
 */
export interface RulesStamp {
  gdpWired: string;
  journey: string;
  project: string;
  grant: string;
  artifact: string;
  task: string;
  personalGroup: string;
  card: string;
  binding: string;
  topic: string;
  post: string;
}

export const RULES: RulesStamp = Object.freeze({
  gdpWired: lock.gdpWired,
  journey: lock.files['generated/journey.js'],
  project: lock.files['generated/project.js'],
  grant: lock.files['generated/grant.js'],
  artifact: lock.files['generated/artifact.js'],
  task: lock.files['generated/task.js'],
  personalGroup: lock.files['generated/personalGroup.js'],
  card: lock.files['generated/card.js'],
  binding: lock.files['generated/binding.js'],
  topic: lock.files['generated/topic.js'],
  post: lock.files['generated/post.js'],
});

/** Whether `stamp` names exactly the rule modules this build runs. */
export function sameRules(stamp: unknown): boolean {
  if (typeof stamp !== 'object' || stamp === null) return false;
  const given = stamp as Record<string, unknown>;
  return (Object.keys(RULES) as (keyof RulesStamp)[]).every((key) => given[key] === RULES[key]);
}

/**
 * A rule state in canonical JSON form: map cells sorted by key, with cells
 * that hold the map's default left out. Two states that read alike serialize
 * alike, so a refused step (which may still touch a cell with its own value)
 * compares equal to the state before it.
 */
export interface Snapshot {
  scalars: Record<string, number>;
  maps: Record<string, [number, number][]>;
  defaults?: Record<string, number>;
}

function freeze(state: State): Snapshot {
  const defaults: Record<string, number> = {};
  for (const name of Object.keys(state.defaults ?? {}).sort()) {
    const value = state.defaults?.[name] ?? 0;
    if (value !== 0) defaults[name] = value;
  }
  const maps: Record<string, [number, number][]> = {};
  for (const name of Object.keys(state.maps).sort()) {
    const fallback = defaults[name] ?? 0;
    maps[name] = [...(state.maps[name] ?? new Map<number, number>())]
      .filter(([, value]) => value !== fallback)
      .sort(([a], [b]) => a - b);
  }
  const scalars: Record<string, number> = {};
  for (const name of Object.keys(state.scalars).sort()) scalars[name] = state.scalars[name] ?? 0;
  return Object.keys(defaults).length > 0 ? { scalars, maps, defaults } : { scalars, maps };
}

function thaw(snapshot: Snapshot): State {
  const maps: Record<string, Map<number, number>> = {};
  for (const [name, cells] of Object.entries(snapshot.maps)) maps[name] = new Map(cells);
  return snapshot.defaults === undefined
    ? { scalars: { ...snapshot.scalars }, maps }
    : { scalars: { ...snapshot.scalars }, maps, defaults: { ...snapshot.defaults } };
}

/** One generated rule module with its parameters fixed. */
export interface Rule {
  init(): Snapshot;
  /** The state after one request. Never changes `snapshot`; throws RangeError for a request outside the rule's bounds. */
  step(snapshot: Snapshot, input: Record<string, number | Map<number, number>>): Snapshot;
}

function rule(module: Machine, params: Record<string, number>): Rule {
  return {
    init: () => freeze(module.init(params)),
    step: (snapshot, input) => freeze(module.step(params, thaw(snapshot), input)),
  };
}

/** Members of one journey occupy slots 1 to SLOTS - 1; slots are never reused. */
export const SLOTS = 65_536;

export const journeyRule = rule(journeyModule, { slots: SLOTS });
export const projectRule = rule(projectModule, {});
export const cardRule = rule(cardModule, {});
export const bindingRule = rule(bindingModule, { person: 1 });
export const topicRule = rule(topicModule, {});
export const postRule = rule(postModule, {});
export const grantRule = rule(grantModule, {});
export const artifactRule = rule(artifactModule, {});
export const taskRule = rule(taskModule, {});
export const personalGroupRule = (owner: number) => rule(groupModule, { owner, slots: SLOTS });

/** The value of a scalar. */
export function scalar(snapshot: Snapshot, name: string): number {
  return snapshot.scalars[name] ?? 0;
}

/** The value of one map cell, as the generated module reads it. */
export function cell(snapshot: Snapshot, map: string, key: number): number {
  const found = snapshot.maps[map]?.find(([k]) => k === key);
  return found === undefined ? (snapshot.defaults?.[map] ?? 0) : found[1];
}

/** The cells of a map that differ from its default. */
export function cells(snapshot: Snapshot, map: string): [number, number][] {
  return snapshot.maps[map] ?? [];
}

/** Whether two states agree, leaving out the named scalars (such as a check's answer). */
export function sameState(a: Snapshot, b: Snapshot, ignore: readonly string[] = []): boolean {
  const strip = (s: Snapshot) => {
    const scalars = { ...s.scalars };
    for (const name of ignore) delete scalars[name];
    return JSON.stringify({ scalars, maps: s.maps, defaults: s.defaults ?? {} });
  };
  return strip(a) === strip(b);
}
