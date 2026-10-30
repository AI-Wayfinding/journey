import * as z from 'zod';
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { capabilities, type Capability } from '../../rules/src/capabilities.ts';
import { cardRule, cell, scalar, type Snapshot } from './rules.ts';
import { Refused } from './commands.ts';
const natural = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const snapshotSchema = z.object({ scalars: z.record(z.string(), natural), maps: z.record(z.string(), z.array(z.tuple([natural, natural]))), defaults: z.record(z.string(), natural).optional() }).strict();
export const actorSchema = z.object({ personId: z.string().min(1).max(200), agent: z.object({ id: z.string().min(1).max(200), name: z.string().max(4096), live: z.boolean(), card: snapshotSchema }).strict().optional() }).strict();
export const assertionSchema = z.object({ id: z.string(), rawId: z.string(), type: z.literal('public-key'), clientExtensionResults: z.object({}).strip(),
  response: z.object({ clientDataJSON: z.string(), authenticatorData: z.string(), signature: z.string(), userHandle: z.string().optional() }).strict() }).strict();

export const capabilitySchema = z.enum(capabilities.map(c => c.name));
const id = z.string().min(1).max(200);
export const changeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('card'), agentId: id, capabilities: z.array(capabilitySchema).max(capabilities.length) }).strict(),
  z.object({ kind: z.enum(['bind', 'unbind']), clientId: id, agentId: id }).strict(),
]);
export type CardChange = z.infer<typeof changeSchema>;
export interface ClientIdentity { subject: string; clientId: string }
export interface AccountAgent { id: string; name: string; live: boolean; card: Snapshot }
export interface Actor { personId: string; agent?: AccountAgent }
export interface PasskeyCredential { id: string; publicKey: number[]; counter: number }
export interface PendingAssertion { challenge: string; digest: string; expiresAt: number }
export interface AgentAccount {
  agents: AccountAgent[]; clients: string[]; bindings: Snapshot; passkeys: PasskeyCredential[]; assertions: PendingAssertion[]; live: boolean;
}
export interface PasskeyVerifier {
  verify(assertion: AuthenticationResponseJSON, challenge: string, credentials: readonly PasskeyCredential[]): Promise<{ credentialId: string; counter: number }>;
}
export class WebAuthnVerifier implements PasskeyVerifier {
  async verify(assertion: AuthenticationResponseJSON, challenge: string, credentials: readonly PasskeyCredential[]) {
    const credential = credentials.find(c => c.id === assertion.id);
    if (!credential) throw new Refused('Unknown passkey');
    const result = await verifyAuthenticationResponse({ response: assertion, expectedChallenge: challenge,
      expectedOrigin: 'https://poc.wayfinding.support', expectedRPID: 'poc.wayfinding.support', requireUserVerification: true,
      credential: { id: credential.id, publicKey: Uint8Array.from(credential.publicKey), counter: credential.counter } });
    if (!result.verified) throw new Refused('Passkey assertion refused');
    return { credentialId: result.authenticationInfo.credentialID, counter: result.authenticationInfo.newCounter };
  }
}
export function cardCaps(card: Snapshot): Capability[] { return capabilities.filter(c => cell(card, 'Caps', c.id) === 1).map(c => c.name); }
export function assignable(names: readonly Capability[]): Capability[] {
  if (names.includes('grant.issue')) throw new Refused('grant.issue is person-only and never assignable');
  return capabilities.filter(c => names.includes(c.name)).map(c => c.name);
}
export function stepCard(card: Snapshot, op: 'sign' | 'narrow' | 'widen' | 'withdraw' | 'check', names: readonly Capability[] = [], cap: Capability = 'read', personHolds = false, personLive = true, agentLive = true, asserted = false): Snapshot {
  return cardRule.step(card, { op: ['sign', 'narrow', 'widen', 'withdraw', 'check'].indexOf(op), cap: capabilities.find(c => c.name === cap)!.id,
    personAsserted: +asserted, personHolds: +personHolds, personLive: +personLive, agentLive: +agentLive,
    NewCaps: new Map(names.map(name => [capabilities.find(c => c.name === name)!.id, 1])) });
}
export function allows(actor: Actor, capability: Capability, personHolds: boolean, personLive = true, agentLive = true): boolean {
  if (!actor.agent) return personHolds && personLive;
  if (capability === 'grant.issue') return false;
  return scalar(stepCard(actor.agent.card, 'check', [], capability, personHolds, personLive, agentLive && actor.agent.live), 'allowed') === 1;
}
export function requireAccountCapability(actor: Actor, cap: Capability): void {
  if (!allows(actor, cap, true)) throw new Refused(`Account capability ${cap} refused`);
}
export async function changeDigest(personId: string, change: CardChange): Promise<string> {
  const canonical = change.kind === 'card' ? [personId, 'card', change.agentId, assignable(change.capabilities)] : [personId, change.kind, change.clientId, change.agentId];
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)))));
}
export function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
