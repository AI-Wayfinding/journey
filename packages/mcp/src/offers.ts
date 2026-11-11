import * as z from 'zod';
import { sealedOfferDefinition, type SealedOfferDefinition } from './sealed-descriptors.ts';
import { Refused } from './errors.ts';
import type { Snapshot } from './rules.ts';

const id = z.string().min(1).max(200);
const decision = z.enum(['allow', 'hold', 'deny']);
export const admissionRuleSchema = z.object({
  who: z.union([z.enum(['owner', 'guide', 'members', 'people', 'agents']), z.object({ person: id }).strict(), z.object({ agent: id }).strict()]),
  journeys: z.array(id).max(128).optional(), decision,
  limit: z.object({ count: z.number().int().min(1).max(1000), per: z.enum(['hour', 'day', 'week']) }).strict().optional(),
}).strict();
export const admissionSchema = z.object({ rules: z.array(admissionRuleSchema).max(50), default: decision }).strict();
export type AdmissionRule = z.infer<typeof admissionRuleSchema>;
export type AdmissionPolicy = z.infer<typeof admissionSchema>;
export const settingsSchema = z.object({ publishWithoutReview: z.boolean(), maxAdmission: z.enum(['hold', 'allow']), maxRequestsPerDay: z.number().int().min(0).max(1000) }).strict();
export type OwnerOfferSettings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: OwnerOfferSettings = { publishWithoutReview: false, maxAdmission: 'hold', maxRequestsPerDay: 0 };
export const ADMISSION_OPEN: AdmissionPolicy = { rules: [{ who: 'members', decision: 'allow' }], default: 'hold' };
export const ADMISSION_MEMBERS: AdmissionPolicy = { rules: [{ who: 'people', decision: 'allow' }], default: 'hold' };
export const ADMISSION_ASK_ME: AdmissionPolicy = { rules: [{ who: 'owner', decision: 'allow' }], default: 'hold' };

// A deliberately bounded JSON Schema subset. Unsupported constraints fail closed,
// rather than being silently ignored. No refs, regex, code generation or network.
const schemaKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'title', 'description']);
const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function boundedJson(value: unknown, label: string, maxDepth = 8): void {
  let nodes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > maxDepth) throw new Refused(`${label} exceeds nesting or node limit`);
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || v === null) throw new Refused(`${label} must be JSON`);
    for (const child of Object.values(v)) visit(child, depth + 1);
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 16 * 1024) throw new Refused(`${label} exceeds 16 KiB`);
}
export function validateJsonSchema(schema: Record<string, unknown>, label: string): void {
  boundedJson(schema, label, 12);
  if (schema.type !== 'object') throw new Refused(`${label} must have type object`);
  const visit = (s: unknown): void => {
    if (!object(s)) throw new Refused(`${label}: schema object required`);
    for (const key of Object.keys(s)) if (!schemaKeys.has(key)) throw new Refused(`${label}: unsupported schema keyword ${key}`);
    if (s.type !== undefined && (typeof s.type !== 'string' || !types.includes(s.type))) throw new Refused(`${label}: unsupported type`);
    if (s.properties !== undefined) {
      if (!object(s.properties)) throw new Refused(`${label}: invalid properties`);
      Object.values(s.properties).forEach(visit);
    }
    if (s.items !== undefined) visit(s.items);
    if (s.required !== undefined && (!Array.isArray(s.required) || !s.required.every(k => typeof k === 'string') || new Set(s.required).size !== s.required.length)) throw new Refused(`${label}: invalid required`);
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') throw new Refused(`${label}: additionalProperties must be boolean`);
    if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v)))) throw new Refused(`${label}: enum must contain scalar JSON values`);
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
      const n = s[k];
      if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || (k !== 'minimum' && k !== 'maximum' && (!Number.isSafeInteger(n) || n < 0)))) throw new Refused(`${label}: invalid ${k}`);
    }
    for (const k of ['title', 'description']) if (s[k] !== undefined && typeof s[k] !== 'string') throw new Refused(`${label}: invalid ${k}`);
  };
  visit(schema);
}
export function validateData(data: unknown, schema: Record<string, unknown>, label: string): void {
  boundedJson(data, label);
  if (!object(data)) throw new Refused(`${label} must be an object`);
  const check = (v: unknown, s: Record<string, unknown>): void => {
    const fail = () => { throw new Refused(`${label} does not match schema`); };
    const t = s.type;
    if (t === 'object' && !object(v) || t === 'array' && !Array.isArray(v) || t === 'string' && typeof v !== 'string' || t === 'boolean' && typeof v !== 'boolean' || t === 'number' && typeof v !== 'number' || t === 'integer' && (typeof v !== 'number' || !Number.isInteger(v)) || t === 'null' && v !== null) fail();
    if (Array.isArray(s.enum) && !s.enum.includes(v)) fail();
    if (typeof v === 'number' && (typeof s.minimum === 'number' && v < s.minimum || typeof s.maximum === 'number' && v > s.maximum)) fail();
    if (typeof v === 'string') {
      const length = [...v].length;
      if (typeof s.minLength === 'number' && length < s.minLength || typeof s.maxLength === 'number' && length > s.maxLength) fail();
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems || typeof s.maxItems === 'number' && v.length > s.maxItems) fail();
      if (object(s.items)) for (const item of v) check(item, s.items);
    }
    if (object(v)) {
      if (Array.isArray(s.required)) for (const key of s.required) if (typeof key === 'string' && !Object.hasOwn(v, key)) fail();
      const props = object(s.properties) ? s.properties : {};
      for (const [key, value] of Object.entries(v)) {
        if (Object.hasOwn(props, key) && object(props[key])) check(value, props[key]);
        else if (s.additionalProperties === false) fail();
      }
    }
  };
  check(data, schema);
}
const jsonSchema = z.record(z.string(), z.unknown()).superRefine((s, ctx) => { try { validateJsonSchema(s, 'Schema'); } catch (e) { ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : 'Invalid schema' }); } });
export const journeySettingSchema = z.object({ enabled: z.boolean(), maxRequestsPerDay: z.number().int().min(1).max(1000).optional() }).strict();
export const journeySettingsSchema = z.record(id, journeySettingSchema).refine(v => Object.keys(v).length <= 128, 'At most 128 offer journeys');
export type JourneySettings = z.infer<typeof journeySettingsSchema>;
// Sealed generations use immutable P source and J publication references.
// Legacy definitions remain supported only by the unsealed generation.
export const offerDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/), name: z.string().trim().min(1).max(60), description: z.string().max(1000),
  tags: z.array(z.string().min(1).max(60)).max(10).default([]), examples: z.array(z.string().max(1000)).max(5).default([]),
  inputSchema: jsonSchema, outputSchema: jsonSchema.optional(), journeySettings: journeySettingsSchema.optional(),
  admission: admissionSchema.optional(), preset: z.enum(['Open', 'Members', 'Ask me', 'Custom']).optional(),
  resource: z.string().min(1).max(200).optional(), instructions: z.string().max(1000).optional(), sealed: sealedOfferDefinition.optional(),
}).strict();
export type OfferDefinition = z.infer<typeof offerDefinitionSchema>;
export interface OfferContent { name: string; description: string; tags: string[]; examples: string[]; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; resource?: string; instructions?: string }
export interface Offer { id: string; content: OfferContent; sealed?: SealedOfferDefinition; contentRevision: number; journeySettings: JourneySettings; admission: AdmissionPolicy; status: 'draft' | 'published' | 'retired'; version: number; createdAt: number; updatedAt: number; agentDefined?: boolean }
export interface OfferAgent { id: string; name: string; owner: string; card: Snapshot; offers: Offer[]; settings: OwnerOfferSettings }
export interface StandingDecision { id: string; owner: string; agentId: string; offerId: string; who: { person: string } | { agent: string }; decision: 'allow' | 'deny' }
// Host-only reservation: identity and guide status come from Journey authority, never tool input.
export const allowanceRequestSchema = z.object({
  taskId: id, agentId: id, offerId: id, version: z.number().int().min(1), journeyId: id,
  requesterId: id, requesterPersonId: id, isAgent: z.boolean(), isGuide: z.boolean(),
}).strict();
export type AllowanceRequest = z.infer<typeof allowanceRequestSchema>;
export interface AllowanceReceipt extends AllowanceRequest { createdAt: number; decision: 'allow' | 'hold' }
export const permitRequestSchema = z.object({ taskId: id, agentId: id, offerId: id, journeyId: id }).strict();
export type PermitRequest = z.infer<typeof permitRequestSchema>;
export interface AdmissionPermit extends PermitRequest { issuedAt: number }
export interface AllowanceRelease { taskId: string; permitOnly?: boolean }
export interface OfferPort {
  directory(): Promise<OfferAgent[]>; stand(decision: StandingDecision): Promise<void>;
  reserve(request: AllowanceRequest): Promise<'allow' | 'hold'>;
  approve(request: PermitRequest): Promise<'allow' | 'hold'>;
  release(taskId: string, permitOnly?: boolean): Promise<void>;
}
export function offerView(o: Offer) { return { id: o.id, sealed: o.sealed, privateDefinition: o.sealed?.privateDefinition, publications: o.sealed?.publications, name: o.content.name, description: o.content.description, tags: o.content.tags, examples: o.content.examples, inputSchema: o.content.inputSchema, outputSchema: o.content.outputSchema, resource: o.content.resource, instructions: o.content.instructions, journeySettings: o.journeySettings, contentRevision: o.contentRevision, admission: o.admission, status: o.status, version: o.version, createdAt: o.createdAt, updatedAt: o.updatedAt }; }
export function presetPolicy(preset: OfferDefinition['preset']): AdmissionPolicy {
  return structuredClone(preset === 'Open' ? ADMISSION_OPEN : preset === 'Ask me' ? ADMISSION_ASK_ME : ADMISSION_MEMBERS);
}
export function clampAdmission(policy: AdmissionPolicy, ceiling: OwnerOfferSettings): AdmissionPolicy {
  if (ceiling.maxAdmission === 'allow') return structuredClone(policy);
  return { rules: policy.rules.map(r => ({ who: r.who, journeys: r.journeys, limit: r.limit, decision: r.decision === 'allow' ? 'hold' : r.decision })), default: policy.default === 'allow' ? 'hold' : policy.default };
}
export function isRaisingCeiling(current: OwnerOfferSettings, proposed: Partial<OwnerOfferSettings>): boolean {
  return proposed.publishWithoutReview === true && !current.publishWithoutReview || proposed.maxAdmission === 'allow' && current.maxAdmission === 'hold' || proposed.maxRequestsPerDay !== undefined && current.maxRequestsPerDay > 0 && (proposed.maxRequestsPerDay === 0 || proposed.maxRequestsPerDay > current.maxRequestsPerDay);
}
export interface AdmissionContext { requesterId: string; requesterPersonId: string; isAgent: boolean; owner: string; isGuide: boolean; journeyId: string }
export function matchingRule(policy: AdmissionPolicy, c: AdmissionContext): AdmissionRule | undefined {
  return policy.rules.find(r => (!r.journeys || r.journeys.includes(c.journeyId)) && (r.who === 'members' || r.who === 'owner' && !c.isAgent && c.requesterPersonId === c.owner || r.who === 'guide' && !c.isAgent && c.isGuide || r.who === 'people' && !c.isAgent || r.who === 'agents' && c.isAgent || typeof r.who === 'object' && ('agent' in r.who ? c.isAgent && c.requesterId === r.who.agent : !c.isAgent && c.requesterPersonId === r.who.person)));
}
export function periodMs(per: 'hour' | 'day' | 'week'): number { return per === 'hour' ? 3_600_000 : per === 'day' ? 86_400_000 : 604_800_000; }

/** No wildcard: absent entries, including future memberships, are off. */
export function journeyEnabled(offer: Offer, journeyId: string): boolean {
  return Object.hasOwn(offer.journeySettings, journeyId) && offer.journeySettings[journeyId]!.enabled && (!offer.sealed || !!offer.sealed.publications[journeyId]);
}
export function clampJourneyLimits(offers: Offer[], settings: OwnerOfferSettings, now: number): void {
  if (!settings.maxRequestsPerDay) return;
  for (const offer of offers) {
    let changed = false;
    for (const row of Object.values(offer.journeySettings)) if (row.maxRequestsPerDay !== undefined && row.maxRequestsPerDay > settings.maxRequestsPerDay) {
      row.maxRequestsPerDay = settings.maxRequestsPerDay; changed = true;
    }
    if (changed) { offer.version++; offer.updatedAt = now; }
  }
}
/** Copy named fields, preserve omitted limits, and reject every agent widening path. */
export function editJourneySettings(current: JourneySettings, supplied: JourneySettings, settings: OwnerOfferSettings, isAgent: boolean): JourneySettings {
  const next: JourneySettings = structuredClone(current);
  for (const [journeyId, row] of Object.entries(supplied)) {
    const before = Object.hasOwn(current, journeyId) ? current[journeyId] : undefined;
    const limit = row.maxRequestsPerDay ?? before?.maxRequestsPerDay;
    if (limit !== undefined && settings.maxRequestsPerDay && limit > settings.maxRequestsPerDay) throw new Refused('Journey limit exceeds agent ceiling');
    if (isAgent && (row.enabled && !before?.enabled || before?.maxRequestsPerDay !== undefined && (limit === undefined || limit > before.maxRequestsPerDay))) throw new Refused('Agents may only narrow or disable offer journeys');
    Object.defineProperty(next, journeyId, { value: { enabled: row.enabled, ...(limit === undefined ? {} : { maxRequestsPerDay: limit }) }, enumerable: true, writable: true, configurable: true });
  }
  if (Object.keys(next).length > 128) throw new Refused('At most 128 offer journeys');
  return next;
}
