import { describe, expect, it } from 'vitest';
import { createSigningIdentity } from '@ai-wayfinding/core';
import { verifyAgentSignature } from '../../server/src/crypto.js';
import { signedHeaders } from '../src/signing.js';

describe('agent request signing', () => {
  it('matches the server verifier for the exact path, query, body, timestamp and nonce', async () => {
    const keys = await createSigningIdentity();
    const path = '/v1/journeys/example/records?after=1&limit=100';
    const body = JSON.stringify({ name: 'A journey' });
    const headers = await signedHeaders(keys.privateKey, 'post', path, body, '1790000000000', 'one');
    expect(await verifyAgentSignature(keys.publicKey, 'POST', path, body, headers['X-Agent-Timestamp'], headers['X-Agent-Nonce'], headers['X-Agent-Signature'])).toBe(true);
    expect(await verifyAgentSignature(keys.publicKey, 'POST', path + '&extra=1', body, headers['X-Agent-Timestamp'], headers['X-Agent-Nonce'], headers['X-Agent-Signature'])).toBe(false);
    expect(await verifyAgentSignature(keys.publicKey, 'POST', path, body + ' ', headers['X-Agent-Timestamp'], headers['X-Agent-Nonce'], headers['X-Agent-Signature'])).toBe(false);
  });
  it('uses a fresh nonce on each request and the server rejects replay and stale timestamps', async () => {
    const keys = await createSigningIdentity();
    const a = await signedHeaders(keys.privateKey, 'GET', '/v1/journeys/example/log', '', String(Date.now()));
    const b = await signedHeaders(keys.privateKey, 'GET', '/v1/journeys/example/log', '', String(Date.now()));
    expect(a['X-Agent-Nonce']).not.toBe(b['X-Agent-Nonce']);
    expect(await verifyAgentSignature(keys.publicKey, 'GET', '/v1/journeys/example/log', '', a['X-Agent-Timestamp'], a['X-Agent-Nonce'], a['X-Agent-Signature'])).toBe(true);
    // The server's nonce registry and timestamp gate are exercised against workerd in integration.test.ts.
  });
});
