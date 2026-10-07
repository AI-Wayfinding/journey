import type { Env } from '../src/index.js';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { effectiveScope, generateJourneyKey, importSigningKey, newId, recipientsHash, sealControlLabels, signControlProof, unwrapJourneyKey, type Member } from '@ai-wayfinding/core';
import { EnclaveObject, Registry } from '../src/index.js';
import { fixture, as, request, settings, addPerson, change, proof, submit, snapshot, state, pending, wraps, person, addAgent, agentRequest, agentHeaders, enclaveStub, registryStub } from './stage0-fixtures.js';

describe('verified Stage 0 controls (Worker and SQLite seam)', () => {
  it('pins creation, rejects a forged creation without any partial registry or journey state', async () => {
    const { owner, j } = await fixture();
    const id = newId();
    const entry = { v: 1 as const, seq: 0, prev: null, at: new Date().toISOString(), actor: owner.principal, type: 'genesis', body: { journey: id, name: 'SECRET creation', creator: { id: owner.principal, kind: 'person', recipient: owner.age.recipient, signingKey: owner.signing.publicKey }, grants: ['members.manage'], mode: 'sealed', visibility: 'private', minClientVersion: '0.1.4' } };
    const envelope = await sealControlLabels(entry, { id: newId(), journey: id, seq: 0, epoch: 1, createdAt: entry.at }, j.key);
    const creation = { proof: await signControlProof(entry, envelope, id, await importSigningKey(owner.signing.privateKey)), envelope };
    const body = { id, creator: entry.body.creator, control: { ...creation, proof: { ...creation.proof, sig: 'AAAA' } }, wraps: await wraps(j, [entry.body.creator]), recoveryWrap: 'YWJjZA==' };
    expect((await request('/v1/journeys', 'POST', body, as(owner))).status).toBe(400);
    expect(await runInDurableObject(enclaveStub(id), (_o, s) => s.storage.sql.exec('SELECT * FROM meta').toArray())).toEqual([]);
    expect(await runInDurableObject(registryStub(), (_o, s) => s.storage.sql.exec('SELECT * FROM journeys WHERE id=?', id).toArray())).toEqual([]);
    for (const history of [{ legacy: j.entries }, { history: j.entries }, { genesis: 'YWJjZA==' }]) {
      expect((await request('/v1/journeys', 'POST', { ...body, control: creation, ...history }, as(owner))).status).toBe(400);
      expect(await runInDurableObject(enclaveStub(id), (_o, s) => s.storage.sql.exec('SELECT * FROM meta').toArray())).toEqual([]);
    }
    expect((await request('/v1/journeys', 'POST', { ...body, control: creation, unnamed: 'SECRET extra' }, as(owner))).status).toBe(201);
    const stored = await runInDurableObject(enclaveStub(id), (_o, s) => JSON.stringify(s.storage.sql.exec('SELECT * FROM authority').toArray()));
    expect(stored).not.toContain('SECRET');
    expect(stored).toContain(owner.signing.publicKey);
  });
  it('rejects forged, replayed, stale, cross-journey, mismatched ciphertext and plain-row changes atomically', async () => {
    const { owner, j } = await fixture();
    const control = await proof(j, owner, 'member.profile', { id: owner.principal, name: 'Private label' });
    const before = await snapshot(j);
    const bad = [
      { control: { ...control, proof: { ...control.proof, sig: 'AAAA' } } },
      { control: { ...control, proof: { ...control.proof, journey: newId() } } },
      { control: { ...control, proof: { ...control.proof, seq: 99 } } },
      { control: { ...control, envelope: { ...control.envelope, ciphertext: control.envelope.ciphertext.replace(/^./, 'A') + 'AAAA' } } },
      { control, accessChanges: [{ principal: owner.principal, action: 'remove', kind: 'person', scope: 'read' }] },
      { entry: 'YWJjZA==' },
      { control: { ...control, proof: { ...control.proof, unknown: 'SECRET' } } },
      { control: { ...control, proof: { ...control.proof, body: { ...control.proof.body, role: 'read-write' } } } },
    ];
    for (const body of bad) {
      expect((await request(`/v1/journeys/${j.id}/log`, 'POST', body, as(owner))).ok).toBe(false);
      expect(await snapshot(j)).toBe(before);
    }
    expect((await submit(j, owner, control, { unnamed: 'SECRET extra' })).status).toBe(400);
    expect(await snapshot(j)).toBe(before);
    expect((await submit(j, owner, control)).status).toBe(201);
    const committed = await snapshot(j);
    expect(committed).not.toContain('SECRET'); expect(committed).not.toContain('Private label');
    expect((await submit(j, owner, control)).status).toBe(409);
    expect(await snapshot(j)).toBe(committed);
  });
  it('serializes concurrent signed controls across asynchronous signature checks', async () => {
    const { owner, j } = await fixture();
    const a = await proof(j, owner, 'member.profile', { id: owner.principal, name: 'A' });
    const b = await proof(j, owner, 'member.profile', { id: owner.principal, name: 'B' });
    const results = await Promise.all([a, b].map(control => request(`/v1/journeys/${j.id}/log`, 'POST', { control }, as(owner))));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await runInDurableObject(enclaveStub(j.id), (_o, s) => s.storage.sql.exec('SELECT seq FROM log').toArray())).toHaveLength(2);
  });
  it('projects signed settings and admission defaults, without changing existing or support roles', async () => {
    const { owner, j } = await fixture();
    const existing = await addPerson(j, owner);
    await settings(j, owner, 'read-only');
    const readonly = await addPerson(j, owner);
    const support = await addPerson(j, owner, { support: true });
    await settings(j, owner);
    const writable = await addPerson(j, owner);
    const derived = await state(j);
    expect(effectiveScope(derived, existing.principal)).toBe('readwrite');
    expect(derived.members[readonly.principal]!.member.scope).toBe('read');
    expect(effectiveScope(derived, writable.principal)).toBe('readwrite');
    expect(derived.members[support.principal]!.member.scope).toBe('read');
    const expiry = derived.members[support.principal]!.member.expiresAt;
    for (const [type, body] of [['member.role', { member: support.principal, role: 'read-write' }], ['grant.add', { member: support.principal, grant: 'members.manage' }], ['member.renew', { id: support.principal, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }]] as const) expect((await change(j, owner, type, body)).status).toBe(403);
    expect((await state(j)).members[support.principal]!.member.expiresAt).toBe(expiry);
    const stored = await snapshot(j);
    expect(stored).not.toContain('Private name'); expect(stored).not.toContain('Private description');
    expect(stored).toContain('invitation-only');
  });
  it('binds support and person public keys to the server-owned pending invitation', async () => {
    const { owner, j } = await fixture();
    const guest = await person(`support-${newId()}@example.org`);
    const expires = await pending(j, owner, guest, true);
    const member: Member = { id: guest.principal, kind: 'person', recipient: guest.age.recipient, signingKey: guest.signing.publicKey, support: true, scope: 'read', expiresAt: new Date(expires).toISOString() };
    const before = await snapshot(j);
    for (const candidate of [{ ...member, expiresAt: new Date(expires + 1).toISOString() }, { ...member, signingKey: owner.signing.publicKey }, { id: member.id, kind: 'person', recipient: member.recipient, signingKey: member.signingKey }]) {
      expect((await submit(j, owner, await proof(j, owner, 'member.add', { member: candidate, kind: 'person', grants: [] }), { wraps: await wraps(j, [member]) })).status).toBe(403);
      expect(await snapshot(j)).toBe(before);
    }
  });
  it.each([false, true])('admits a person with every epoch exactly once after rotation (support=%s)', async support => {
    const { owner, j } = await fixture();
    const keys = [j.key];
    for (const epoch of [2, 3]) {
      const removed = await addAgent(j, owner, 'read', false, keys);
      expect((await change(j, owner, 'member.remove', { member: removed.principal })).status).toBe(201);
      const members = (await state(j)).members;
      const key = generateJourneyKey(epoch);
      expect((await submit(j, owner, await proof(j, owner, 'key.rotate', { epoch, recipientsHash: await recipientsHash(members) }, key), { wraps: await wraps(j, Object.values(members).map(m => m.member), key) })).status).toBe(201);
      j.key = key; keys.push(key);
    }
    const guest = await person(`history-${newId()}@example.org`);
    const expires = await pending(j, owner, guest, support);
    const member: Member = { id: guest.principal, kind: 'person', recipient: guest.age.recipient, signingKey: guest.signing.publicKey, ...(support ? { support: true as const, scope: 'read' as const, expiresAt: new Date(expires).toISOString() } : {}) };
    const control = await proof(j, owner, 'member.add', { member, kind: 'person', grants: [] });
    const delivery = (await Promise.all(keys.map(key => wraps(j, [member], key)))).flat();
    const ownerHash = await runInDurableObject(enclaveStub(j.id), (_o, s) => String(s.storage.sql.exec('SELECT accountHash FROM principals WHERE id=?', owner.principal).toArray()[0]!.accountHash));
    const admission = await runInDurableObject(registryStub(), (_o, s) => s.storage.sql.exec('SELECT * FROM pending_principals WHERE principal=?', member.id).toArray()[0]!);
    const before = await snapshot(j);
    const malformed = [
      { reason: 'epoch zero', wraps: [{ ...delivery[0]!, epoch: 0 }, ...delivery.slice(1)] },
      { reason: 'future epoch', wraps: [...delivery.slice(0, 2), { ...delivery[2]!, epoch: 4 }] },
      { reason: 'historic gap', wraps: [delivery[0]!, delivery[2]!] },
      { reason: 'missing first epoch', wraps: delivery.slice(1) },
      { reason: 'missing current epoch', wraps: delivery.slice(0, 2) },
      { reason: 'no wraps', wraps: [] },
      { reason: 'duplicate principal and epoch', wraps: [delivery[0]!, delivery[0]!, delivery[2]!] },
      { reason: 'extra duplicate', wraps: [...delivery, delivery[0]!] },
      { reason: 'foreign principal', wraps: [delivery[0]!, { ...delivery[1]!, principal: owner.principal }, delivery[2]!] },
    ];
    for (const candidate of malformed) {
      expect((await submit(j, owner, control, { wraps: candidate.wraps })).status, candidate.reason).toBe(400);
      // Exercise the SQLite seam too, so the HTTP parser cannot mask a missing storage guard.
      const response = await enclaveStub(j.id).fetch(new Request('https://internal', { method: 'POST', body: JSON.stringify({ op: 'controlWrite', journeyId: j.id, subject: { principal: owner.principal, accountHash: ownerHash, clientVersion: '0.1.4', controlFormat: 'control-proof-v1' }, control, admission: { id: member.id, kind: 'person', recipient: member.recipient, signingKey: member.signingKey, accountHash: admission.accountHash, support, ...(support ? { expiresAt: expires } : {}) }, wraps: candidate.wraps }) }));
      expect(response.status, candidate.reason).toBe(400);
      expect(await snapshot(j), candidate.reason).toBe(before);
      expect((await request(`/v1/journeys/${j.id}/log`, 'GET', undefined, as(guest))).status).toBe(403);
    }
    expect((await submit(j, owner, control, { wraps: delivery.slice().reverse() })).status).toBe(201);
    const stored = await (await request(`/v1/journeys/${j.id}/wraps/me`, 'GET', undefined, as(guest))).json() as { wraps: { epoch: number; wrap: string }[] };
    expect(stored.wraps.map(w => w.epoch)).toEqual([1, 2, 3]);
    for (const w of stored.wraps) expect((await unwrapJourneyKey({ epoch: w.epoch, recipient: member.id, ciphertext: w.wrap }, guest.age.identity)).key).toEqual(keys[w.epoch - 1]!.key);
    if (support) expect((await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(guest))).status).toBe(403);

    const agent = await agentRequest(j, owner, 'read', false, keys);
    const extraHistory = await wraps(j, [agent.member], keys[0]!);
    const beforeAgent = await snapshot(j);
    const rejectedAgent = await enclaveStub(j.id).fetch(new Request('https://internal', { method: 'POST', body: JSON.stringify({ op: 'controlWrite', journeyId: j.id, subject: { principal: owner.principal, accountHash: ownerHash, clientVersion: '0.1.4', controlFormat: 'control-proof-v1' }, control: agent.approval.control, admission: { id: agent.principal, kind: 'agent', recipient: agent.member.recipient, signingKey: agent.member.signingKey, scope: 'read', expiresAt: agent.expiresAt }, wraps: [...extraHistory, { principal: agent.principal, epoch: 3, wrap: agent.approval.wrap }] }) }));
    expect(rejectedAgent.status).toBe(400);
    expect(await snapshot(j)).toBe(beforeAgent);
    expect((await request(`/v1/agent-sessions/${agent.id}/approve`, 'POST', agent.approval, as(owner))).status).toBe(200);
    const path = `/v1/journeys/${j.id}/wraps/me`;
    const agentWraps = await (await request(path, 'GET', undefined, await agentHeaders(agent, 'GET', path))).json() as { wraps: { epoch: number; wrap: string }[] };
    expect(agentWraps.wraps.map(w => w.epoch)).toEqual([1, 2, 3]);
    for (const w of agentWraps.wraps) expect((await unwrapJourneyKey({ epoch: w.epoch, recipient: agent.principal, ciphertext: w.wrap }, agent.age.identity)).key).toEqual(keys[w.epoch - 1]!.key);
  });
  it('purges only legacy journey data on schema upgrade; no migration or caller history trust', async () => {
    const { owner, j } = await fixture();
    await addAgent(j, owner);
    await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(owner));
    await runInDurableObject(enclaveStub(j.id), (_o, s) => {
      s.storage.sql.exec("INSERT INTO records VALUES(99,'legacy',1,0,'legacy','legacy')");
      for (const table of ['meta','records','log','principals','wraps','recovery_wraps','reservations','authority']) expect(s.storage.sql.exec(`SELECT * FROM ${table}`).toArray().length).toBeGreaterThan(0);
      s.storage.sql.exec('UPDATE schema_version SET version=1');
      new EnclaveObject(s, env as unknown as Env);
      expect(s.storage.sql.exec('SELECT version FROM schema_version').toArray()).toEqual([{ version: 2 }]);
      for (const table of ['meta','records','log','principals','wraps','recovery_wraps','reservations','authority']) expect(s.storage.sql.exec(`SELECT * FROM ${table}`).toArray()).toEqual([]);
    });
    await runInDurableObject(registryStub(), (_o, s) => {
      const tables = ['accounts','credentials','sessions','agent_sessions'];
      const before = tables.map(t => s.storage.sql.exec(`SELECT * FROM ${t}`).toArray());
      for (const rows of before) expect(rows.length).toBeGreaterThan(0);
      s.storage.sql.exec('UPDATE journey_schema SET version=1');
      new Registry(s);
      expect(tables.map(t => s.storage.sql.exec(`SELECT * FROM ${t}`).toArray())).toEqual(before);
      for (const t of ['journeys','account_principals','invites','pending_principals','agent_links']) expect(s.storage.sql.exec(`SELECT * FROM ${t}`).toArray()).toEqual([]);
      expect(s.storage.sql.exec('SELECT version FROM journey_schema').toArray()).toEqual([{ version: 2 }]);
    });
  });
});
