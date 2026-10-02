import { env, runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { hashControlProof, importSigningKey, newId, projectPurposeHash, sealProjectPayload, signControlProof, type JsonObject, type ProjectActionType } from '@ai-wayfinding/core';
import { EnclaveObject, type Env } from '../src/index.js';
import { fixture as stage1, change, enclaveStub, request, as, agentHeaders, type Journey, type Person } from './stage1-fixtures.js';
import type { ControlInput, EnclaveMessage } from '../src/types.js';
export * from './stage1-fixtures.js';
export async function fixture() {
  const f = await stage1();
  expect((await change(f.j, f.owner, 'client.minVersion', { version: '0.1.6' })).status).toBe(201);
  return f;
}
export async function project(j: Journey, actor: Pick<Person, 'principal' | 'signing'>, type: ProjectActionType, body: JsonObject, purpose?: string): Promise<ControlInput> {
  const seq = j.controls.length, at = new Date().toISOString();
  const entry = { v: 1 as const, seq, prev: await hashControlProof(j.controls.at(-1)!.proof), at, actor: actor.principal, type, body: { format: 'project-v1', ...body } };
  const envelope = await sealProjectPayload(type, entry.body, purpose === undefined ? {} : { purpose }, { id: newId(), journey: j.id, epoch: j.key.epoch, seq, createdAt: at }, j.key);
  return { proof: await signControlProof(entry, envelope, j.id, await importSigningKey(actor.signing.privateKey)), envelope };
}
export async function createProject(j: Journey, actor: Person, purpose = 'PRIVATE PROJECT PURPOSE') {
  const id = newId();
  const control = await project(j, actor, 'project.create', { project: id, purposeHash: await projectPurposeHash(purpose), state: 'getting-started' }, purpose);
  expect((await send(j, actor, control)).status).toBe(201);
  return { id, revision: control.proof.seq, purpose };
}
export async function send(j: Journey, actor: Pick<Person, 'principal' | 'signing'> & Partial<Pick<Person, 'cookie'>>, control: ControlInput, extra: Record<string, string> = {}) {
  const path = `/v1/journeys/${j.id}/log`, body = { control };
  const headers = actor.cookie ? as(actor as Person) : await agentHeaders(actor as Awaited<ReturnType<typeof import('./stage0-fixtures.js').addAgent>>, 'POST', path, body);
  const response = await request(path, 'POST', body, { ...headers, ...extra });
  if (response.status === 201) j.controls.push(control);
  return response;
}
export async function persisted(j: Journey) {
  return runInDurableObject(enclaveStub(j.id), (_o, s) => JSON.parse(String(s.storage.sql.exec('SELECT state FROM authority').one().state)));
}
export async function freshRead(j: Journey, actor: Person) {
  return runInDurableObject(enclaveStub(j.id), async (_o, s) => {
    const accountHash = String(s.storage.sql.exec('SELECT accountHash FROM principals WHERE id=?', actor.principal).one().accountHash);
    const response = await new EnclaveObject(s, env as unknown as Env).fetch(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ op: 'log', journeyId: j.id, after: -1, subject: { principal: actor.principal, accountHash, clientVersion: '0.1.6', controlFormat: 'control-proof-v1', artifactFormat: 'artifact-v1', projectFormat: 'project-v1' } }) }));
    return { status: response.status, body: await response.json() };
  });
}
/** Put real signed requests behind a barrier on the production object's serialization queue. */
export async function queued(j: Journey, actor: Person, controls: ControlInput[], actors: Person[] = controls.map(() => actor)) {
  return runInDurableObject(enclaveStub(j.id), async (o, s) => {
    let release!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    const queue = o as unknown as { serialized(work: () => Promise<void>): Promise<void>; fetch(request: Request): Promise<Response> };
    const held = queue.serialized(() => barrier);
    const requests = controls.map((control, i) => {
      const currentActor = actors[i]!;
      const accountHash = String(s.storage.sql.exec('SELECT accountHash FROM principals WHERE id=?', currentActor.principal).one().accountHash);
      return queue.fetch(new Request('https://internal/', { method: 'POST', body: JSON.stringify({ op: 'controlWrite', journeyId: j.id, control, subject: { principal: currentActor.principal, accountHash, clientVersion: '0.1.6', controlFormat: 'control-proof-v1', artifactFormat: 'artifact-v1', projectFormat: 'project-v1' } } satisfies EnclaveMessage) }));
    });
    // Request JSON parsing yields; let each fetch enter the same queue before releasing it.
    await new Promise(r => setTimeout(r, 0)); release(); await held;
    return Promise.all(requests.map(async r => { const response = await r; return response.status; }));
  });
}
