import { isId } from './ids.js';
import type { JsonObject, ProtocolRecord, Validation } from './types.js';
export interface ItemBody extends JsonObject { id: string; itemType: string; title: string; body: string; author: string; authoredBy: 'human' | 'agent' | 'mixed'; created: string; tags: string[]; links?: { to: string; rel: string }[]; replaces?: string; sharedFrom?: string; resourceKind?: string }
export interface CommentBody extends JsonObject { id: string; item: string; onVersion: string; author: string; authoredBy: 'human' | 'agent' | 'mixed'; at: string; inReplyTo?: string; body: string }
export interface DeleteBody extends JsonObject { target: string }
export interface RecordDefinition { name: string; version: number; validate(body: JsonObject): Validation; upgrade?: (previous: JsonObject) => JsonObject }
export interface KnownRecord { kind: 'known'; record: ProtocolRecord }
export interface UnknownRecord { kind: 'unknown'; raw: ProtocolRecord }
export type ParsedRecord = KnownRecord | UnknownRecord;
const valid = (): Validation => ({ ok: true });
const invalid = (reason: string): Validation => ({ ok: false, reason });
const string = (value: unknown): value is string => typeof value === 'string';
const authored = (value: unknown): boolean => value === 'human' || value === 'agent' || value === 'mixed';
const optional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || check(value);
export function validateItem(body: JsonObject): Validation {
  if (!isId(body.id) || !string(body.itemType) || !body.itemType || !string(body.title) || !string(body.body) || !string(body.author) || !authored(body.authoredBy) || !string(body.created) || !Array.isArray(body.tags) || !body.tags.every(string)) return invalid('Invalid item fields');
  if (!optional(body.links, v => Array.isArray(v) && v.every(link => link && typeof link === 'object' && isId(link.to) && string(link.rel))) || !optional(body.replaces, isId) || !optional(body.sharedFrom, string) || !optional(body.resourceKind, string)) return invalid('Invalid item extension fields');
  return valid();
}
export function validateComment(body: JsonObject): Validation {
  if (!isId(body.id) || !isId(body.item) || !isId(body.onVersion) || !string(body.author) || !authored(body.authoredBy) || !string(body.at) || !optional(body.inReplyTo, isId) || !string(body.body)) return invalid('Invalid comment fields');
  return valid();
}
export function validateDelete(body: JsonObject): Validation { return isId(body.target) ? valid() : invalid('Invalid deletion target'); }
export const itemDefinitions: readonly RecordDefinition[] = [
  { name: 'item', version: 1, validate: validateItem },
  { name: 'comment', version: 1, validate: validateComment },
  { name: 'delete', version: 1, validate: validateDelete },
];
export function parseRecord(record: ProtocolRecord, definitions: readonly RecordDefinition[] = itemDefinitions): ParsedRecord {
  if (typeof record?.type !== 'string' || !Number.isSafeInteger(record.typeVersion) || !record.body || typeof record.body !== 'object' || Array.isArray(record.body)) throw new Error('Invalid record');
  const versions = definitions.filter(d => d.name === record.type);
  let current = record;
  let definition = versions.find(d => d.version === current.typeVersion);
  if (!definition) return { kind: 'unknown', raw: record };
  while (definition) {
    const result = definition.validate(current.body);
    if (!result.ok) throw new Error(result.reason);
    const next = versions.find(d => d.version === current.typeVersion + 1);
    if (!next?.upgrade) break;
    current = { ...current, typeVersion: next.version, body: next.upgrade(current.body) };
    definition = next;
  }
  return { kind: 'known', record: current };
}
export function serializeRecord(parsed: ParsedRecord): ProtocolRecord { return parsed.kind === 'known' ? parsed.record : parsed.raw; }
