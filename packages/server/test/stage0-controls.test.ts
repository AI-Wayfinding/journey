import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { effectiveScope, importSigningKey, newId, sealControlLabels, signControlProof, type Member } from '@ai-wayfinding/core';
import { EnclaveObject, Registry } from '../src/index.js';
import { fixture, as, request, settings, addPerson, change, proof, submit, snapshot, state, pending, wraps, person, addAgent, enclaveStub, registryStub } from './stage0-fixtures.js';

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
    expect((await submit(j, owner, control, { unnamed: 'SECRET extra' })).status).toBe(201);
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
  it('purges only legacy journey data on schema upgrade; no migration or caller history trust', async () => {
    const { owner, j } = await fixture();
    await addAgent(j, owner);
    await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(owner));
    await runInDurableObject(enclaveStub(j.id), (_o, s) => {
      s.storage.sql.exec("INSERT INTO records VALUES(99,'legacy',1,0,'legacy','legacy')");
      for (const table of ['meta','records','log','principals','wraps','recovery_wraps','reservations','authority']) expect(s.storage.sql.exec(`SELECT * FROM ${table}`).toArray().length).toBeGreaterThan(0);
      s.storage.sql.exec('UPDATE schema_version SET version=1');
      new EnclaveObject(s);
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
