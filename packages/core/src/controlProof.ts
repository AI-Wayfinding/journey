import { isProjectAction, copyProjectPublic, validateProjectPublic, readProjectPayload } from './projects.js';
import { asBuffer, decode, encode, utf8 } from './codec.js';
import { canonical, controlDefinitions, initialLogState, verifyLog } from './log.js';
import type { LogEntry, LogResult, Member, LogState } from './log.js';
import { open, seal } from './envelope.js';
import type { Envelope, OuterMeta } from './envelope.js';
import type { JourneyKey } from './teamKey.js';
import type { JsonObject } from './types.js';
import { stage0Rules } from './rules.js';
import { ruleVersion } from './versions.js';
import { isArtifactAction, copyArtifactPublic, validateArtifactPublic, readArtifactPayload, ARTIFACT_TYPES, artifactTypeHash, MAX_ARTIFACT_PAYLOAD_BYTES } from './artifacts.js';

/** The signed public proof is the ONLY control. Ciphertext holds labels, never
 * an action. Its digest commits the encrypted bytes; body commits each label. */
export interface ControlProof {
  v: 1; journey: string; seq: number; prev: string | null; at: string; actor: string;
  type: string; body: JsonObject; envelopeHash: string; sig: string;
}
const labelFields = ['name', 'description', 'email'] as const;
const unavailable = '[unavailable]';
async function digest(value: unknown): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', asBuffer(utf8(canonical(value))))));
}
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
function privateLabels(entry: Pick<LogEntry, 'body'>): JsonObject {
  const labels: JsonObject = {};
  for (const field of labelFields) if (Object.hasOwn(entry.body, field)) labels[field] = entry.body[field];
  for (const field of ['creator', 'member']) {
    const member = entry.body[field];
    if (object(member) && Object.hasOwn(member, 'name')) labels.memberName = member.name;
  }
  return labels;
}
/** Copy only private labels, including when a caller supplies extra action fields. */
export async function sealControlLabels(entry: Pick<LogEntry, 'body'>, outside: Omit<OuterMeta, 'v' | 'size'>, key: JourneyKey): Promise<Envelope> {
  return seal({ type: 'control.labels', typeVersion: 1, body: privateLabels(entry) }, outside, key);
}
async function projection(entry: Pick<LogEntry, 'type' | 'body'>): Promise<JsonObject> {
  if (isProjectAction(entry.type)) return copyProjectPublic(entry.type, entry.body);
  if (isArtifactAction(entry.type)) return copyArtifactPublic(entry.type, entry.body);
  const definition = controlDefinitions.find(d => d.name === entry.type);
  if (!definition) throw new Error('Unknown control');
  const body: JsonObject = {};
  for (const field of definition.fields) if (Object.hasOwn(entry.body, field)) {
    const value = entry.body[field];
    if (labelFields.includes(field as typeof labelFields[number])) body[field] = await digest(value);
    else if ((field === 'creator' || field === 'member') && object(value)) {
      const copy: JsonObject = { id: value.id, recipient: value.recipient, signingKey: value.signingKey, kind: value.kind };
      for (const key of ['scope', 'addedBy', 'expiresAt', 'support']) if (Object.hasOwn(value, key)) copy[key] = value[key];
      if (value.name !== undefined) copy.name = await digest(value.name);
      body[field] = copy;
    } else if (Array.isArray(value)) body[field] = value.slice();
    else body[field] = value;
  }
  return body;
}
function unsigned(proof: ControlProof): Omit<ControlProof, 'sig'> {
  return { v: proof.v, journey: proof.journey, seq: proof.seq, prev: proof.prev, at: proof.at,
    actor: proof.actor, type: proof.type, body: proof.body, envelopeHash: proof.envelopeHash };
}
export async function hashControlProof(proof: ControlProof): Promise<string> { return digest(proof); }
/** prev is the previous complete proof's hash. Ciphertext is never another action. */
export async function signControlProof(entry: Omit<LogEntry, 'sig'>, envelope: Envelope, journey: string, key: CryptoKey): Promise<ControlProof> {
  if (envelope.outside.journey !== journey || envelope.outside.seq !== entry.seq) throw new Error('Control envelope position mismatch');
  const message: Omit<ControlProof, 'sig'> = { v: 1, journey, seq: entry.seq, prev: entry.prev, at: entry.at, actor: entry.actor,
    type: entry.type, body: await projection(entry), envelopeHash: await digest(envelope) };
  const sig = encode(new Uint8Array(await crypto.subtle.sign('Ed25519', key, asBuffer(utf8(canonical(message))))));
  return { ...message, sig };
}
/** Parse the public body using harmless label placeholders. Label commitments
 * are SHA-256 values, not names/emails; all other fields keep normal validation. */
function publicBody(proof: ControlProof): JsonObject | undefined {
  if (!object(proof.body)) return undefined;
  if (isProjectAction(proof.type)) return validateProjectPublic(proof.type, proof.body).ok ? copyProjectPublic(proof.type, proof.body) : undefined;
  if (isArtifactAction(proof.type)) return validateArtifactPublic(proof.type, proof.body).ok ? copyArtifactPublic(proof.type, proof.body) : undefined;
  const definition = controlDefinitions.find(d => d.name === proof.type);
  if (!definition || Object.keys(proof.body).some(k => !definition.fields.includes(k))) return undefined;
  const body: JsonObject = {};
  const commitment = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value);
  for (const field of definition.fields) if (Object.hasOwn(proof.body, field)) {
    const value = proof.body[field];
    if (labelFields.includes(field as typeof labelFields[number])) {
      if (!commitment(value)) return undefined;
      body[field] = field === 'email' ? 'unavailable@example.invalid' : unavailable;
    } else if ((field === 'creator' || field === 'member') && object(value)) {
      if (Object.keys(value).some(k => !['id', 'recipient', 'signingKey', 'kind', 'scope', 'addedBy', 'expiresAt', 'support', 'name'].includes(k))) return undefined;
      const copy: JsonObject = { id: value.id, recipient: value.recipient, signingKey: value.signingKey, kind: value.kind };
      for (const key of ['scope', 'addedBy', 'expiresAt', 'support']) if (Object.hasOwn(value, key)) copy[key] = value[key];
      if (Object.hasOwn(value, 'name')) {
        if (!commitment(value.name)) return undefined;
        copy.name = unavailable;
      }
      body[field] = copy;
    } else body[field] = Array.isArray(value) ? value.slice() : value;
  }
  return definition.validate(body).ok ? body : undefined;
}
function validLabel(proof: ControlProof, field: string, value: string): boolean {
  const candidate = publicBody(proof)!;
  if (field === 'memberName') {
    for (const key of ['creator', 'member']) if (object(candidate[key])) (candidate[key] as JsonObject).name = value;
  } else candidate[field] = value;
  return controlDefinitions.find(d => d.name === proof.type)!.validate(candidate).ok;
}
export interface ReadControl { entry: LogEntry; unavailableLabels: string[] }
/** Use only after verifying the proof. Invalid/missing ciphertext or label
 * commitments hide labels, not the signed action. Never interpret a log payload. */
export async function readControlProof(proof: ControlProof, envelope: Envelope, key?: JourneyKey): Promise<ReadControl> {
  const body = publicBody(proof);
  if (!body) throw new Error('Invalid public control body');
  if (isArtifactAction(proof.type)) {
    if (key) await readArtifactPayload(proof, envelope, key);
    return { entry: { v: 1, seq: proof.seq, prev: proof.prev, at: proof.at, actor: proof.actor, type: proof.type, body, sig: proof.sig }, unavailableLabels: key ? [] : ['content'] };
  }
  if (isProjectAction(proof.type)) {
    const record = key ? await readProjectPayload(proof, envelope, key) : undefined;
    if (record?.type === 'project.content') body.purpose = record.body.purpose;
    return { entry: { v: 1, seq: proof.seq, prev: proof.prev, at: proof.at, actor: proof.actor, type: proof.type, body, sig: proof.sig }, unavailableLabels: key ? [] : ['purpose'] };
  }
  let labels: JsonObject = {};
  if (key) try {
    const record = await open(envelope, key);
    if (proof.envelopeHash === await digest(envelope) && record.type === 'control.labels' && record.typeVersion === 1
      && Object.keys(record).sort().join(',') === 'body,type,typeVersion'
      && Object.keys(record.body).every(k => [...labelFields, 'memberName'].includes(k))
      && Object.values(record.body).every(value => typeof value === 'string')) labels = record.body;
  } catch { /* Missing old keys and invalid labels do not revoke public authority. */ }
  const unavailableLabels: string[] = [];
  for (const field of labelFields) if (Object.hasOwn(proof.body, field)) {
    if (typeof labels[field] === 'string' && await digest(labels[field]) === proof.body[field] && validLabel(proof, field, labels[field])) body[field] = labels[field];
    else { body[field] = unavailable; unavailableLabels.push(field); }
  }
  for (const field of ['creator', 'member']) {
    const member = proof.body[field];
    if (object(member) && Object.hasOwn(member, 'name')) {
      if (typeof labels.memberName === 'string' && await digest(labels.memberName) === member.name && validLabel(proof, 'memberName', labels.memberName)) (body[field] as JsonObject).name = labels.memberName;
      else unavailableLabels.push('memberName');
    }
  }
  return { entry: { v: 1, seq: proof.seq, prev: proof.prev, at: proof.at, actor: proof.actor, type: proof.type, body, sig: proof.sig }, unavailableLabels };
}
/** Replay the single signed public chain from pinned creation identity.
 * Optional legacy input is only for old core regression readers, never Stage 1. */
export async function verifyControlProofs(proofs: readonly ControlProof[], envelopes: readonly Envelope[], trust: { journey: string; creator: Member }, keys: readonly JourneyKey[] = [], legacy: readonly LogEntry[] = []): Promise<LogResult> {
  let state: LogState | undefined;
  if (legacy.length) {
    const result = await verifyLog(legacy);
    if (!result.ok) return result;
    if (result.state.journey !== trust.journey || canonical(legacy[0]!.body.creator) !== canonical(trust.creator)) return { ok: false, error: { code: 'invalid-entry', seq: 0, message: 'Legacy creation trust mismatch' } };
    state = result.state;
  }
  const offset = legacy.length;
  if (proofs.length !== envelopes.length) return { ok: false, error: { code: 'invalid-entry', seq: offset, message: 'Control envelope count mismatch' } };
  for (let index = 0; index < proofs.length; index++) {
    const proof = proofs[index]!, envelope = envelopes[index], seq = offset + index;
    const fail = (message: string): LogResult => ({ ok: false, error: { code: 'invalid-entry', seq, message } });
    if (!proof || typeof proof !== 'object' || Object.keys(proof).sort().join(',') !== 'actor,at,body,envelopeHash,journey,prev,seq,sig,type,v'
      || (seq === 0) !== (proof.type === 'genesis') || proof.v !== 1 || proof.journey !== trust.journey || !envelope || envelope.outside.journey !== trust.journey
      || typeof proof.at !== 'string' || !Number.isFinite(Date.parse(proof.at)) || typeof proof.actor !== 'string' || typeof proof.sig !== 'string'
      || proof.seq !== seq || envelope.outside.seq !== seq || proof.prev !== (state?.lastHash ?? null)
      || proof.envelopeHash !== await digest(envelope)) return fail('Control ciphertext or position mismatch');
    const body = publicBody(proof);
    if (!body) return fail('Invalid public control body');
    if (isArtifactAction(proof.type) || isProjectAction(proof.type)) {
      if (legacy.length) return fail('No legacy artifact migration');
      if (!Number.isSafeInteger(envelope.outside.size) || envelope.outside.size < 0 || envelope.outside.size > MAX_ARTIFACT_PAYLOAD_BYTES || envelope.outside.epoch !== state?.currentEpoch) return fail('Invalid artifact payload size or epoch');
      if (body.typeHash !== undefined && !(await Promise.all(ARTIFACT_TYPES.map(artifactTypeHash))).includes(body.typeHash as string)) return fail('Unsupported artifact type');
    }
    const signer = seq === 0 ? trust.creator : state?.members[proof.actor]?.member;
    if (!signer || proof.actor !== signer.id) return fail('Unknown control actor');
    if (seq === 0 && (body.journey !== trust.journey || canonical(body.creator) !== canonical(trust.creator))) return fail('Creation trust mismatch');
    try {
      const key = await crypto.subtle.importKey('raw', asBuffer(decode(signer.signingKey)), 'Ed25519', false, ['verify']);
      if (!await crypto.subtle.verify('Ed25519', key, asBuffer(decode(proof.sig)), asBuffer(utf8(canonical(unsigned(proof)))))) return fail('Control signature mismatch');
    } catch { return fail('Invalid control signature'); }
    if (!stage0Rules.stage_ready(ruleVersion(state?.minClientVersion ?? body.minClientVersion as string))) return fail('Control proofs require the legacy upgrade barrier');
    if (isProjectAction(proof.type) && keys.length && !keys.some(k => k.epoch === envelope.outside.epoch)) return fail('Missing project key');
    let entry: LogEntry;
    try { entry = (await readControlProof(proof, envelope, keys.find(k => k.epoch === envelope.outside.epoch))).entry; }
    catch { return fail('Invalid encrypted artifact or project payload'); }
    if (seq === 0) state = initialLogState(entry);
    else {
      const failure = await controlDefinitions.find(d => d.name === proof.type)!.apply?.(state!, entry.body, proof.actor, proof.at);
      if (failure) return { ok: false, error: { code: failure.code, seq, message: failure.message } };
    }
    state!.lastSeq = seq;
    state!.lastHash = await hashControlProof(proof);
  }
  // Legacy consumers inspect the replayed minimum to show their existing update message.
  // Keyed project histories additionally refuse to expose a partial project view.
  if (state && keys.length && proofs.some(proof => isProjectAction(proof.type)) && !stage0Rules.version_ge(ruleVersion('0.1.6'), ruleVersion(state.minClientVersion))) return { ok: false, error: { code: 'client-too-old', seq: state.lastSeq, message: 'Unsupported client minimum; update client' } };
  return state ? { ok: true, state } : { ok: false, error: { code: 'invalid-entry', seq: 0, message: 'Missing creation proof' } };
}
