import type { APIRequestContext } from '@playwright/test';
import type { ControlProof, Envelope, Member } from '@ai-wayfinding/core';
import { createAgeIdentity, createSigningIdentity, ARTIFACT_FORMAT, artifactTypeHash, importSigningKey, newId, sealArtifactPayload, signControlProof, unwrapJourneyKey, verifyControlProofs } from '@ai-wayfinding/core';

type Agent = { id: string; code: string; approvalUrl: string; principal: string; identity: string; signingPrivateKey: CryptoKey };
const ORIGIN = `http://localhost:${process.env.WAYFINDING_E2E_PORT ?? '18787'}`;
const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A separate agent process never has the person's cookies or keys. */
export async function requestAgent(request: APIRequestContext, journeyId: string, name?: string, keyStorage?: 'file'): Promise<Agent> {
  const age = await createAgeIdentity(), signing = await createSigningIdentity();
  const response = await request.post('/v1/agent-sessions', { data: { journeyId, agentPublicKey: { recipient: age.recipient, signingKey: signing.publicKey }, requestedScope: 'readwrite', ...(name === undefined ? {} : { name }), ...(keyStorage === undefined ? {} : { keyStorage }) }, headers: { 'X-Client-Version': '0.1.7', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1', 'X-Private-Format': 'private-v1', 'X-Wayfinding': '1', Origin: ORIGIN } });
  if (!response.ok()) throw new Error(`Agent session rejected (${response.status()}): ${await response.text()}`);
  const { id, code, approvalUrl } = await response.json() as { id: string; code: string; approvalUrl: string };
  const { principal } = await (await request.get('/v1/agent-sessions/' + id)).json() as { principal: string };
  return { id, code, approvalUrl, principal, identity: age.identity, signingPrivateKey: await importSigningKey(signing.privateKey) };
}

async function signed(request: APIRequestContext, agent: Agent, method: 'GET' | 'POST', path: string, data?: unknown): Promise<unknown> {
  const body = data === undefined ? '' : JSON.stringify(data), timestamp = String(Date.now()), nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const hash = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))));
  const message = [method, '/v1' + path, hash, timestamp, nonce].join('\n');
  const signature = b64url(new Uint8Array(await crypto.subtle.sign('Ed25519', agent.signingPrivateKey, new TextEncoder().encode(message))));
  const response = await request.fetch('/v1' + path, { method, data: method === 'GET' ? undefined : body, headers: { 'X-Client-Version': '0.1.7', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1', 'X-Private-Format': 'private-v1', 'X-Agent-Session': agent.id, 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': signature, ...(method === 'POST' ? { 'X-Client-Version': '0.1.7', 'X-Control-Format': 'control-proof-v1', 'X-Artifact-Format': 'artifact-v1', 'X-Project-Format': 'project-v1', 'X-Private-Format': 'private-v1', 'X-Wayfinding': '1', Origin: ORIGIN, 'Content-Type': 'application/json' } : {}) } });
  if (!response.ok()) throw new Error(`Signed agent request ${path} rejected (${response.status()}): ${await response.text()}`);
  return response.json();
}

export async function agentWritesItem(request: APIRequestContext, agent: Agent, journeyId: string): Promise<void> {
  const wraps = await signed(request, agent, 'GET', `/journeys/${journeyId}/wraps/me`) as { wraps: { epoch: number; wrap: string }[] };
  const newest = wraps.wraps.at(-1)!;
  const key = await unwrapJourneyKey({ epoch: newest.epoch, recipient: 'agent', ciphertext: newest.wrap }, agent.identity);
  const rows = (await signed(request, agent, 'GET', `/journeys/${journeyId}/log`) as { log: { proof: ControlProof; envelope: Envelope }[] }).log;
  const verified = await verifyControlProofs(rows.map(r => r.proof), rows.map(r => r.envelope), { journey: journeyId, creator: rows[0]!.proof.body.creator as Member });
  if (!verified.ok) throw new Error(verified.error.message);
  const at = new Date().toISOString(), seq = verified.state.lastSeq + 1;
  const body = { format: ARTIFACT_FORMAT, artifact: newId(), version: newId(), author: agent.principal, actor: agent.principal, typeHash: await artifactTypeHash('document'), blobs: [] };
  const envelope = await sealArtifactPayload('artifact.create', body, { title: 'Agent observation', content: { kind: 'document', markdown: 'Written by the approved agent' }, tags: ['note'], attachments: [] }, { id: newId(), journey: journeyId, seq, epoch: key.epoch, createdAt: at }, key);
  const proof = await signControlProof({ v: 1, seq, prev: verified.state.lastHash, at, actor: agent.principal, type: 'artifact.create', body }, envelope, journeyId, agent.signingPrivateKey);
  await signed(request, agent, 'POST', `/journeys/${journeyId}/log`, { control: { proof, envelope } });
}
