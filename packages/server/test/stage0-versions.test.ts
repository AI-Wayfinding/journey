import { describe, expect, it } from 'vitest';
import { newId, seal } from '@ai-wayfinding/core';
import { fixture, as, request, proof, change, snapshot } from './stage0-fixtures.js';

describe('Stage 0 version and format barrier', () => {
  it('refuses 0.1.3 and earlier or missing format before serving content or accepting controls', async () => {
    const { owner, j } = await fixture();
    const { seq } = await (await request(`/v1/journeys/${j.id}/seq`, 'POST', {}, as(owner))).json() as { seq: number };
    const envelope = await seal({ type: 'item', typeVersion: 1, body: {} }, { id: newId(), journey: j.id, seq, epoch: 1, createdAt: new Date().toISOString() }, j.key);
    const control = await proof(j, owner, 'member.profile', { id: owner.principal, name: 'Not stored' });
    for (const capability of [
      ...['0.0.9','0.1.0','0.1.1','0.1.2','0.1.3','', 'garbage'].map(version => ({ 'X-Client-Version': version })),
      { 'X-Control-Format': '' }, { 'X-Control-Format': 'future-format' },
    ]) {
      const headers = { ...as(owner), ...capability };
      const before = await snapshot(j);
      for (const suffix of ['records','log','wraps/me','export','invites/pending','agent-links']) {
        const response = await request(`/v1/journeys/${j.id}/${suffix}`, 'GET', undefined, headers);
        expect(response.status).toBe(426);
        expect(await response.json()).toEqual({ error: { code: 'client-too-old' }, minClientVersion: '0.1.4', controlFormat: 'control-proof-v1' });
      }
      for (const [suffix, body] of [['seq', {}], ['records', { envelope }], ['log', { control }]] as const) expect((await request(`/v1/journeys/${j.id}/${suffix}`, 'POST', body, headers)).status).toBe(426);
      expect(await snapshot(j)).toBe(before);
      expect(await (await request(`/v1/journeys/${j.id}/protocol`, 'GET', undefined, headers)).json()).toEqual({ minClientVersion: '0.1.4', controlFormat: 'control-proof-v1' });
    }
  });

  it('does not let capability claims authorize a forged or unsupported control; signed minimum is durable and monotonic', async () => {
    const { owner, j } = await fixture();
    const control = await proof(j, owner, 'member.profile', { id: owner.principal, name: 'Private' });
    const before = await snapshot(j);
    for (const candidate of [{ ...control, proof: { ...control.proof, sig: 'AAAA' } }, { ...control, proof: { ...control.proof, type: 'future.control' } }]) {
      expect((await request(`/v1/journeys/${j.id}/log`, 'POST', { control: candidate }, { ...as(owner), 'X-Client-Version': '99.0.0' })).status).toBe(400);
      expect(await snapshot(j)).toBe(before);
    }
    expect((await change(j, owner, 'client.minVersion', { version: '0.1.7' })).status).toBe(201);
    expect((await request(`/v1/journeys/${j.id}/export`, 'GET', undefined, as(owner))).status).toBe(426);
    const headers = { ...as(owner), 'X-Client-Version': '0.1.7' };
    expect((await request(`/v1/journeys/${j.id}/export`, 'GET', undefined, headers)).status).toBe(200);
    const lower = await proof(j, owner, 'client.minVersion', { version: '0.1.3' });
    expect((await request(`/v1/journeys/${j.id}/log`, 'POST', { control: lower }, headers)).status).toBe(403);
    expect(await (await request(`/v1/journeys/${j.id}/protocol`, 'GET', undefined, as(owner))).json()).toEqual({ minClientVersion: '0.1.7', controlFormat: 'control-proof-v1', artifactFormat: 'artifact-v1' });
  });
});
