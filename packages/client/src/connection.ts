import { createAgeIdentity, createSigningIdentity, validAgentName } from '@ai-wayfinding/core';
import { rm } from 'node:fs/promises';
import { JourneyClient } from './journey.js';
import { networkFetch } from './network.js';
import { DeniedStateError, ExpiredStateError, ensureNewStatePath, loadState, saveState } from './state.js';
import type { PendingState } from './state.js';
import type { RememberedAgent, StoreOptions } from './storage.js';
import { saveRemembered } from './storage.js';

export interface ConnectOptions { server?: string; scope?: 'read' | 'readwrite'; name?: string; remember?: boolean; keyFolder?: string; passphrase?: string; fetch?: typeof fetch; pollMs?: number; timeoutMs?: number; state?: string; onApproval?: (url: string, code: string) => void }
export interface Connection { client: JourneyClient; session: RememberedAgent }
export const DEFAULT_SERVER = 'https://app.wayfinding.support';
const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
export class PendingApprovalError extends Error { readonly exitCode = 2; }

export async function requestConnection(journeyId: string, options: ConnectOptions = {}): Promise<PendingState> {
  const server = (options.server ?? DEFAULT_SERVER).replace(/\/$/, '');
  const origin = new URL(server);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && (origin.hostname === 'localhost' || origin.hostname === '127.0.0.1'))) throw new Error('The journey server must use HTTPS (except on this computer).');
  if (options.keyFolder && !options.remember) throw new Error('--key-folder needs --remember.');
  if (options.state && options.remember) throw new Error('Use either --state or --remember, not both.');
  if (options.name !== undefined && !validAgentName(options.name)) throw new Error('Agent name must be trimmed, 1–60 characters and contain no control characters.');
  if (options.state) await ensureNewStatePath(options.state);
  const identity = await createAgeIdentity(), signing = await createSigningIdentity();
  const response = await (options.fetch ?? networkFetch)(server + '/v1/agent-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin.origin, 'X-Wayfinding': '1' }, body: JSON.stringify({ journeyId, agentPublicKey: { recipient: identity.recipient, signingKey: signing.publicKey }, requestedScope: options.scope ?? 'read', remembered: options.remember === true, keyStorage: options.state ? 'file' : 'memory', ...(options.name === undefined ? {} : { name: options.name }) }) });
  if (!response.ok) throw new Error('Could not ask to join this journey (' + response.status + ').');
  const created = await response.json() as { id: string; code: string; approvalUrl: string };
  const createdAt = Date.now();
  const pending: PendingState = { status: 'pending', server, journeyId, sessionId: created.id, identity: identity.identity, recipient: identity.recipient, signingPrivateKey: signing.privateKey, signingKey: signing.publicKey, requestedScope: options.scope ?? 'read', link: created.approvalUrl, code: created.code, createdAt, expiresAt: createdAt + 600_000 };
  if (options.state) await saveState(options.state, pending, true);
  options.onApproval?.(created.approvalUrl, created.code);
  return pending;
}

export async function waitForApproval(pending: PendingState, options: ConnectOptions = {}): Promise<Connection> {
  const fetcher = options.fetch ?? networkFetch;
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  for (;;) {
    if (pending.expiresAt <= Date.now()) { if (options.state) await rm(options.state, { force: true }); throw new ExpiredStateError('Journey approval expired. Connect again.'); }
    if (Date.now() >= deadline) throw new PendingApprovalError('Journey approval is still pending. Run connect --state <file> --wait again.');
    const polled = await fetcher(pending.server + '/v1/agent-sessions/' + encodeURIComponent(pending.sessionId));
    if (!polled.ok) throw new Error('Could not check journey approval (' + polled.status + ').');
    const approved = await polled.json() as { status: string; principal: string; scope: 'read' | 'readwrite'; expiresAt: number; remembered: boolean; journeyId: string; recipient: string; signingKey: string; requestedScope: string };
    if (approved.status === 'pending') { await sleep(Math.min(options.pollMs ?? 3000, deadline - Date.now(), pending.expiresAt - Date.now())); continue; }
    if (approved.status === 'expired') { if (options.state) await rm(options.state, { force: true }); throw new ExpiredStateError('Journey approval expired. Connect again.'); }
    if (approved.status !== 'approved') throw new DeniedStateError(approved.status === 'locked' ? 'Too many wrong approval codes. Ask for a new journey connection.' : 'Journey approval was refused. Connect again.');
    if (approved.journeyId !== pending.journeyId || approved.recipient !== pending.recipient || approved.signingKey !== pending.signingKey || approved.requestedScope !== pending.requestedScope) throw new Error('Journey approval does not match this agent. Connect again.');
    if (options.remember && !approved.remembered) throw new Error('The person did not approve remembered journey access.');
    if (!Number.isFinite(approved.expiresAt) || approved.expiresAt <= Date.now() || approved.expiresAt > Date.now() + (options.remember ? 90 * 86_400_000 : 8 * 3_600_000) + 60_000 || approved.scope !== 'read' && approved.scope !== 'readwrite') throw new Error('Invalid journey access expiry or scope. Connect again.');
    const expiresAt = options.state ? Math.min(approved.expiresAt, pending.createdAt + 8 * 3_600_000) : approved.expiresAt;
    const session: RememberedAgent = { server: pending.server, journeyId: pending.journeyId, sessionId: pending.sessionId, principal: approved.principal, identity: pending.identity, recipient: pending.recipient, signingPrivateKey: pending.signingPrivateKey, signingKey: pending.signingKey, scope: approved.scope, expiresAt };
    const client = new JourneyClient(session, { fetch: options.fetch });
    try { await client.status(); }
    catch (error) { client.close(); throw error; }
    if (options.remember) {
      const store: StoreOptions = options.keyFolder ? { folder: options.keyFolder, passphrase: options.passphrase } : {};
      await saveRemembered(session, store);
    }
    if (options.state) await saveState(options.state, { status: 'approved', session, createdAt: pending.createdAt, expiresAt, link: pending.link, code: pending.code });
    return { client, session };
  }
}

export async function connectJourney(journeyId: string, options: ConnectOptions = {}): Promise<Connection> {
  return waitForApproval(await requestConnection(journeyId, options), options);
}
export async function resumeConnection(path: string, options: ConnectOptions = {}): Promise<Connection> {
  const state = await loadState(path);
  if (state.status === 'pending') return waitForApproval(state, { ...options, state: path });
  const client = new JourneyClient(state.session, { fetch: options.fetch });
  try { await client.status(); } catch (error) { client.close(); throw error; }
  return { client, session: state.session };
}
