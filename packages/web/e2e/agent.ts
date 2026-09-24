import type { APIRequestContext } from '@playwright/test';
import { createAgeIdentity, createSigningIdentity, importSigningKey, newId, seal, unwrapJourneyKey } from '@ai-wayfinding/core';

type Agent = { id: string; code: string; approvalUrl: string; identity: string; signingPrivateKey: CryptoKey };
const ORIGIN = 'http://localhost:18787';
const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A separate agent process never has the person's cookies or keys. */
export async function requestAgent(request: APIRequestContext, journeyId: string): Promise<Agent> {
  const age = await createAgeIdentity(), signing = await createSigningIdentity();
  const response = await request.post('/v1/agent-sessions', { data: { journeyId, agentPublicKey: { recipient: age.recipient, signingKey: signing.publicKey }, requestedScope: 'readwrite' }, headers: { 'X-Wayfinding': '1', Origin: ORIGIN } });
  if (!response.ok()) throw new Error(`Agent session rejected (${response.status()}): ${await response.text()}`);
  const { id, code, approvalUrl } = await response.json() as { id: string; code: string; approvalUrl: string };
  return { id, code, approvalUrl, identity: age.identity, signingPrivateKey: await importSigningKey(signing.privateKey) };
}

async function signed(request: APIRequestContext, agent: Agent, method: 'GET' | 'POST', path: string, data?: unknown): Promise<unknown> {
  const body = data === undefined ? '' : JSON.stringify(data), timestamp = String(Date.now()), nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const hash = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))));
  const message = [method, '/v1' + path, hash, timestamp, nonce].join('\n');
  const signature = b64url(new Uint8Array(await crypto.subtle.sign('Ed25519', agent.signingPrivateKey, new TextEncoder().encode(message))));
  const response = await request.fetch('/v1' + path, { method, data: method === 'GET' ? undefined : body, headers: { 'X-Agent-Session': agent.id, 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': signature, ...(method === 'POST' ? { 'X-Wayfinding': '1', Origin: ORIGIN, 'Content-Type': 'application/json' } : {}) } });
  if (!response.ok()) throw new Error(`Signed agent request ${path} rejected (${response.status()}): ${await response.text()}`);
  return response.json();
}

export async function agentWritesItem(request: APIRequestContext, agent: Agent, journeyId: string): Promise<void> {
  const wraps = await signed(request, agent, 'GET', `/journeys/${journeyId}/wraps/me`) as { wraps: { epoch: number; wrap: string }[] };
  const newest = wraps.wraps.at(-1)!;
  const key = await unwrapJourneyKey({ epoch: newest.epoch, recipient: 'agent', ciphertext: newest.wrap }, agent.identity);
  const reserved = await signed(request, agent, 'POST', `/journeys/${journeyId}/seq`, {}) as { seq: number; epoch: number };
  if (reserved.epoch !== key.epoch) throw new Error('Agent key changed before the write');
  const envelope = await seal({ type: 'item', typeVersion: 1, body: { id: newId(), itemType: 'note', title: 'Agent observation', body: 'Written by the approved agent', author: 'agent', authoredBy: 'agent', tags: [], created: new Date().toISOString() } }, { id: newId(), journey: journeyId, seq: reserved.seq, epoch: reserved.epoch, createdAt: new Date().toISOString() }, key);
  await signed(request, agent, 'POST', `/journeys/${journeyId}/records`, { envelope });
}
