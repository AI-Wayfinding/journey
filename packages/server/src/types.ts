import type { Envelope } from '@ai-wayfinding/core';

export type Kind = 'person' | 'agent';
export type Scope = 'read' | 'readwrite';
export interface Principal { id: string; kind: Kind; scope: Scope; expiresAt?: number; accountHash?: string }
export interface AccessChange { principal: string; action: 'add' | 'remove'; kind: Kind; scope: Scope; expiresAt?: number; accountHash?: string; addedBy?: string }
export interface EpochWrap { principal: string; epoch: number; wrap: string }
export interface CipherEntry { seq: number; entry: string }
export interface CreateJourney { id: string; name: string; creatorEmail: string; creatorHash: string; creator: Principal; genesis: string; wraps: EpochWrap[]; recoveryWrap: string; minClientVersion: string }
export interface RecordInput { envelope: Envelope }
export type ErrorCode = 'invalid-request' | 'unauthorized' | 'forbidden' | 'csrf' | 'not-found' | 'conflict' | 'old-epoch' | 'rate-limited' | 'too-large' | 'internal';
export function failure(code: ErrorCode, status: number): Response { return Response.json({ error: { code } }, { status }); }
export function validString(value: unknown, max = 4096): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
export function validEpoch(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
export function validSeq(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validScope(value: unknown): value is Scope { return value === 'read' || value === 'readwrite'; }
export function validKind(value: unknown): value is Kind { return value === 'person' || value === 'agent'; }
export function validExpiry(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > Date.now(); }
export function limitNumber(value: string | undefined, fallback: number): number | null { if (value === undefined) return fallback; const n = Number(value); return /^\d+$/.test(value) && Number.isSafeInteger(n) && n <= 1000 ? n : null; }
export function sequenceCursor(value: string | undefined, fallback: number): number | null { if (value === undefined) return fallback; const n = Number(value); return /^\d+$/.test(value) && Number.isSafeInteger(n) ? n : null; }

// Only the Worker calls these objects; the public JSON boundary validates and copies named fields first.
export interface Subject { principal: string; accountHash?: string; agent?: boolean }
export type RegistryMessage =
  | { op: 'emailStart'; ipHash: string; emailHash: string; tokenHash: string }
  | { op: 'emailVerify'; tokenHash: string; sessionHash: string }
  | { op: 'session' | 'logout'; hash: string }
  | { op: 'credentials' | 'journeys' | 'keysGet'; accountHash: string }
  | { op: 'keysPut'; accountHash: string; identity: string; signing: string }
  | { op: 'credential'; id: string; accountHash: string }
  | { op: 'challengeSet'; sessionHash: string; challenge: string; kind: 'register' | 'login' }
  | { op: 'challengeTake'; sessionHash: string; kind: 'register' | 'login' }
  | { op: 'credentialAdd'; id: string; accountHash: string; publicKey: string; counter: number; transports: string; sessionHash: string }
  | { op: 'credentialUse'; id: string; accountHash: string; counter: number; sessionHash: string }
  | { op: 'journeyCreate'; data: CreateJourney }
  | { op: 'journeyDelete'; id: string }
  | { op: 'registry' }
  | { op: 'link'; accountHash: string; journeyId: string; principal: string }
  | { op: 'activity'; id: string; memberDelta: number; bytes: number }
  | { op: 'inviteCreate'; hash: string; journeyId: string; expires: number; support: boolean }
  | { op: 'inviteTake'; hash: string; accountHash: string; principal: string; recipient: string; signingKey: string }
  | { op: 'invitePending'; journeyId: string }
  | { op: 'pendingGet' | 'pendingDelete'; journeyId: string; principal: string }
  | { op: 'agentCreate'; id: string; journeyId: string; principal: string; recipient: string; signingKey: string; requestedScope: Scope; code: string; remembered: boolean }
  | { op: 'agentGet'; id: string }
  | { op: 'agentAttempt'; id: string; code: string }
  | { op: 'agentApprove'; id: string; scope: Scope; expires: number }
  | { op: 'nonce'; id: string; nonce: string };
type JourneyMessage = { journeyId: string; subject: Subject };
export type EnclaveMessage =
  | { op: 'create'; data: CreateJourney }
  | (JourneyMessage & (
      { op: 'access' | 'inviteAccess' | 'reserve' | 'wraps' | 'export' }
    | { op: 'recordWrite'; envelope: Envelope }
    | { op: 'records'; after: number; limit: number }
    | { op: 'logWrite'; entry: string; changes: AccessChange[]; memberWraps?: EpochWrap[]; wraps?: EpochWrap[]; epoch?: number }
    | { op: 'log'; after: number }
  ));
