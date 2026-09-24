import { createAgeIdentity, createSigningIdentity } from '@ai-wayfinding/core';
import { JourneyClient } from './journey.js';
import type { RememberedAgent } from './storage.js';
import { saveRemembered } from './storage.js';
import type { StoreOptions } from './storage.js';
export interface ConnectOptions { server?: string; scope?: 'read' | 'readwrite'; remember?: boolean; keyFolder?: string; passphrase?: string; fetch?: typeof fetch; pollMs?: number; onApproval?: (url: string, code: string) => void }
export interface Connection { client: JourneyClient; session: RememberedAgent }
export const DEFAULT_SERVER = 'https://app.wayfinding.support';
const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
export async function connectJourney(journeyId: string, options: ConnectOptions = {}): Promise<Connection> {
  const server = (options.server ?? DEFAULT_SERVER).replace(/\/$/, '');
  const origin = new URL(server);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && (origin.hostname === 'localhost' || origin.hostname === '127.0.0.1'))) throw new Error('The journey server must use HTTPS (except on this computer).');
  if (options.keyFolder && !options.remember) throw new Error('--key-folder needs --remember.');
  const identity = await createAgeIdentity(), signing = await createSigningIdentity();
  const response = await (options.fetch ?? fetch)(server + '/v1/agent-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin.origin, 'X-Wayfinding': '1' }, body: JSON.stringify({ journeyId, agentPublicKey: { recipient: identity.recipient, signingKey: signing.publicKey }, requestedScope: options.scope ?? 'read', remembered: options.remember === true }) });
  if (!response.ok) throw new Error('Could not ask to join this journey (' + response.status + ').');
  const created = await response.json() as { id: string; code: string; approvalUrl: string };
  options.onApproval?.(created.approvalUrl, created.code);
  let approved: { status: string; principal: string; scope: 'read' | 'readwrite'; expiresAt: number; remembered: boolean };
  for (;;) {
    await sleep(options.pollMs ?? 3000);
    const polled = await (options.fetch ?? fetch)(server + '/v1/agent-sessions/' + encodeURIComponent(created.id));
    if (!polled.ok) throw new Error('Could not check journey approval (' + polled.status + ').');
    approved = await polled.json() as typeof approved;
    if (approved.status === 'approved') break;
    if (approved.status !== 'pending') throw new Error(approved.status === 'locked' ? 'Too many wrong approval codes. Ask for a new journey connection.' : 'Journey approval expired or was refused. Connect again.');
  }
  if (options.remember && !approved.remembered) throw new Error('The person did not approve remembered journey access.');
  if (!Number.isFinite(approved.expiresAt) || approved.expiresAt <= Date.now() || approved.expiresAt > Date.now() + (options.remember ? 90 * 86_400_000 : 8 * 3_600_000) + 60_000) throw new Error('Invalid journey access expiry. Connect again.');
  const session: RememberedAgent = { server, journeyId, sessionId: created.id, principal: approved.principal, identity: identity.identity, recipient: identity.recipient, signingPrivateKey: signing.privateKey, signingKey: signing.publicKey, scope: approved.scope, expiresAt: approved.expiresAt };
  const client = new JourneyClient(session, { fetch: options.fetch });
  try { await client.status(); }
  catch (error) { client.close(); throw error; }
  if (options.remember) {
    const store: StoreOptions = options.keyFolder ? { folder: options.keyFolder, passphrase: options.passphrase } : {};
    await saveRemembered(session, store);
  }
  return { client, session };
}
