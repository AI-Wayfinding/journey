import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { newId, seal, type JsonObject } from '@ai-wayfinding/core';
import { fixture, as, request, addPerson, addAgent, change, settings, agentHeaders, enclaveStub } from './stage0-fixtures.js';

describe('current Stage 0 content access', () => {
  it('uses exact D34 limits on every read and write endpoint, independently of guide grants', async () => {
    const { owner, j } = await fixture();
    const ro = await addAgent(j, owner, 'read'), rw = await addAgent(j, owner, 'readwrite');
    const reservation = await (await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(owner))).json() as { seq: number };
    const envelope = await seal({ type: 'comment', typeVersion: 1, body: { body: 'PRIVATE' } }, { id: newId(), journey: j.id, seq: reservation.seq, epoch: 1, createdAt: new Date().toISOString() }, j.key);
    expect((await change(j, owner, 'member.role', { member: owner.principal, role: 'read-only' })).status).toBe(201);
    for (const type of ['item', 'comment', 'delete']) {
      const changed = await seal({ type, typeVersion: 1, body: { target: newId() } }, { id: newId(), journey: j.id, seq: reservation.seq, epoch: 1, createdAt: new Date().toISOString() }, j.key);
      expect((await request(`/v1/journeys/${j.id}/records`, 'POST', { envelope: changed }, as(owner))).status).toBe(403);
    }
    expect((await request(`/v1/journeys/${j.id}/records`, 'POST', { envelope }, as(owner))).status).toBe(403);
    expect((await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(owner))).status).toBe(403);
    for (const actor of [ro, rw]) {
      const path = `/v1/journeys/${j.id}/seq`;
      expect((await request(path, 'POST', {}, await agentHeaders(actor, 'POST', path, {}))).status).toBe(403);
      for (const suffix of ['records','log','wraps/me','export']) {
        const path = `/v1/journeys/${j.id}/${suffix}`;
        expect((await request(path, 'GET', undefined, await agentHeaders(actor, 'GET', path))).status).toBe(200);
      }
    }
    expect((await change(j, owner, 'member.role', { member: owner.principal, role: 'read-write' })).status).toBe(201);
    const path = `/v1/journeys/${j.id}/seq`;
    expect((await request(path, 'POST', {}, await agentHeaders(ro, 'POST', path, {}))).status).toBe(403);
    expect((await request(path, 'POST', {}, await agentHeaders(rw, 'POST', path, {}))).status).toBe(200);
    expect((await request(`/v1/journeys/${j.id}/records`, 'POST', { envelope }, as(owner))).status).toBe(201);
  });
  it('denies missing or expired adding people and their agents, even when the agent itself is live', async () => {
    const { owner, j } = await fixture();
    const support = await addPerson(j, owner, { support: true, expiresAt: Date.now() + 120_000 });
    const agent = await addAgent(j, support, 'readwrite');
    const path = `/v1/journeys/${j.id}/records`;
    expect((await request(path, 'GET', undefined, await agentHeaders(agent, 'GET', path))).status).toBe(200);
    const now = Date.now();
    try {
      vi.useFakeTimers(); vi.setSystemTime(now + 121_000);
      for (const suffix of ['records','log','wraps/me','export','seq']) {
        const path = `/v1/journeys/${j.id}/${suffix}`, method = suffix === 'seq' ? 'POST' : 'GET', body = suffix === 'seq' ? {} : undefined;
        expect((await request(path, method, body, as(support))).status).toBe(403);
        expect((await request(path, method, body, await agentHeaders(agent, method, path, body))).status).toBe(403);
      }
    } finally { vi.useRealTimers(); }
    await runInDurableObject(enclaveStub(j.id), (_o, s) => {
      const row = s.storage.sql.exec('SELECT state FROM authority').toArray()[0]!;
      const state = JSON.parse(String(row.state)); delete state.members[support.principal];
      s.storage.sql.exec('UPDATE authority SET state=?', JSON.stringify(state));
    });
    expect((await request(path, 'GET', undefined, await agentHeaders(agent, 'GET', path))).status).toBe(403);
  });
  it('rechecks the downgraded person and inherited agent on an earlier reservation', async () => {
    const { owner, j } = await fixture();
    const guest = await addPerson(j, owner), a = await addAgent(j, guest, 'readwrite');
    const path = `/v1/journeys/${j.id}/seq`;
    const { seq } = await (await request(path, 'POST', {}, await agentHeaders(a, 'POST', path, {}))).json() as { seq: number };
    const envelope = await seal({ type: 'delete', typeVersion: 1, body: { target: newId() } }, { id: newId(), journey: j.id, seq, epoch: 1, createdAt: new Date().toISOString() }, j.key);
    expect((await change(j, owner, 'member.role', { member: guest.principal, role: 'read-only' })).status).toBe(201);
    const write = `/v1/journeys/${j.id}/records`, body = { envelope };
    expect((await request(write, 'POST', body, await agentHeaders(a, 'POST', write, body))).status).toBe(403);
    expect(await runInDurableObject(enclaveStub(j.id), (_o, s) => s.storage.sql.exec('SELECT * FROM records').toArray())).toEqual([]);
  });
  it('rejects agent request replay, old timestamps and a signature from a different key', async () => {
    const { owner, j } = await fixture();
    const a = await addAgent(j, owner), b = await addAgent(j, owner);
    const path = `/v1/journeys/${j.id}/records`, headers = await agentHeaders(a, 'GET', path);
    expect((await request(path, 'GET', undefined, headers)).status).toBe(200);
    expect((await request(path, 'GET', undefined, headers)).status).toBe(401);
    expect((await request(path, 'GET', undefined, await agentHeaders(a, 'GET', path, undefined, newId(), String(Date.now() - 61_000)))).status).toBe(401);
    expect((await request(path, 'GET', undefined, { ...await agentHeaders(b, 'GET', path), 'X-Agent-Session': a.id })).status).toBe(401);
  });
});
