import { base64url, assignable, stepCard } from './agents.ts';
import { bindingRule, cardRule, cell, scalar } from './rules.ts';
import { Refused } from './commands.ts';
import type { OAuthAccounts, OAuthOperation, OAuthResult, StoredToken } from './oauth-contract.ts';

export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export const tokenHash = async (value: string) => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));

/** Runs inside AccountsHost's serial turn; its caller atomically replaces accounts, including these records. */
export async function oauthStep(state: OAuthAccounts, op: OAuthOperation, now: number, deviceAsserted = false, sealedMode=false): Promise<OAuthResult> {
  const db = state.oauth ??= { clients: [], requests: [], codes: [], access: [], refresh: [] };
  db.clients = db.clients.filter(c => c.expiresAt === undefined || c.expiresAt > now || state.accounts.some(a => a.live && a.agents.some(g => g.live && g.clientId === c.client_id)));
  db.requests = db.requests.filter(r => r.request.expiresAt > now);
  db.codes = db.codes.filter(r => r.expiresAt > now);
  db.access = db.access.filter(r => r.expiresAt > now);
  // Used refresh hashes remain until their original expiry so reuse still revokes the family.
  db.refresh = db.refresh.filter(r => r.expiresAt > now);
  const invalid = (): OAuthResult => ({ kind: 'error', error: 'invalid_grant' });
  const live = (t: Pick<StoredToken, 'subject' | 'personId' | 'clientId' | 'agentId'>) => {
    const a = state.accounts.find(a => a.subject === t.subject && a.personId === t.personId && a.live);
    const agent = a?.agents.find(g => g.id === t.agentId && g.live && !g.authorizationPending);
    const index = a ? a.clients.indexOf(t.clientId) + 1 : 0;
    return !!(a && agent && cell(a.bindings, 'Bound', index) === 1 && a.agents[cell(a.bindings, 'Agents', index) - 2]?.id === t.agentId);
  };
  const revokeFamily = (family: string) => {
    db.access = db.access.filter(t => t.family !== family);
    db.refresh = db.refresh.filter(t => t.family !== family);
  };
  const issue = async (t: Pick<StoredToken, 'subject' | 'personId' | 'clientId' | 'agentId'>, family = randomToken(), familyExpiry = now + 30 * 86400_000): Promise<OAuthResult> => {
    if ([...db.access, ...db.refresh].filter(token => token.personId === t.personId).length >= 10_000) throw new Refused('Account token capacity reached');
    const access = randomToken(), refresh = randomToken();
    const identity = { subject: t.subject, personId: t.personId, clientId: t.clientId, agentId: t.agentId };
    db.access.push({ ...identity, hash: await tokenHash(access), expiresAt: now + 3_600_000, family });
    db.refresh.push({ ...identity, hash: await tokenHash(refresh), expiresAt: familyExpiry, family });
    return { kind: 'tokens', tokens: { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 } };
  };
  switch (op.op) {
    case 'register': {
      const client = { client_id: `client_${randomToken()}`, client_name: sealedMode?'MCP client':op.client.client_name, redirect_uris: op.client.redirect_uris,
        expiresAt: now + 86_400_000, token_endpoint_auth_method: op.client.token_endpoint_auth_method, grant_types: op.client.grant_types, response_types: op.client.response_types };
      db.clients.push(client); return { kind: 'client', client };
    }
    case 'client': return { kind: 'client', client: db.clients.find(c => c.client_id === op.clientId) };
    case 'request': {
      if (op.request) {
        if (db.requests.some(r => r.id === op.id)) throw new Refused('Authorization already exists');
        db.requests.push({ id: op.id, request: {clientId:op.request.clientId,clientName:sealedMode?'MCP client':op.request.clientName,redirectUri:op.request.redirectUri,challenge:op.request.challenge,browserHash:op.request.browserHash,state:op.request.state,expiresAt:op.request.expiresAt} });
      }
      return { kind: 'request', request: db.requests.find(r => r.id === op.id)?.request };
    }
    case 'deny': db.requests = db.requests.filter(r => r.id !== op.id); return { kind: 'ok' };
    case 'consent-options': throw new Refused('Passkey options require the Accounts host');
    case 'consent': {
      const request = db.requests.find(r => r.id === op.id)?.request;
      const account = state.accounts.find(a => a.subject === op.subject && a.live);
      if (!request || !account) throw new Refused('Fresh authorization and account required');
      const caps = assignable(op.consent.capabilities);
      if (caps.includes('device.keys') && !deviceAsserted) throw new Refused('Device keys require a passkey assertion');
      let client = account.clients.indexOf(request.clientId) + 1;
      let agent = cell(account.bindings, 'Bound', client) === 1 ? account.agents[cell(account.bindings, 'Agents', client) - 2] : undefined;
      // Do not let overlapping consent submissions race their cross-object journey updates.
      if (agent?.authorizationPending && db.requests.some(r => r.id === agent?.pendingConsentId)) throw new Refused('Authorization already in progress');
      if (!agent?.live) {
        agent = { id: `agent_${crypto.randomUUID()}`, name: op.consent.name, live: true, card: cardRule.init(), createdAt: now };
        account.agents.push(agent);
      }
      agent.name = sealedMode?agent.id:op.consent.name; agent.clientId = request.clientId;if(!sealedMode)agent.clientName=request.clientName;
      agent.authorizationPending = true; agent.pendingConsentId = op.id;
      agent.card = stepCard(agent.card, scalar(agent.card, 'signed') ? 'widen' : 'sign', caps, 'read', false, true, true, true);
      if (!client) { account.clients.push(request.clientId); client = account.clients.length; }
      account.bindings = bindingRule.step(account.bindings, { op: 0, client, agent: account.agents.indexOf(agent) + 2, personAsserted: 1, agentIsOwnLive: 1, personLive: 1, boundAgentLive: 1 });
      if (cell(account.bindings, 'Bound', client) !== 1 || account.agents[cell(account.bindings, 'Agents', client) - 2]?.id !== agent.id) throw new Refused('Client binding refused');
      return { kind: 'agent', agentId: agent.id };
    }
    case 'manage': {
      const account = state.accounts.find(a => a.subject === op.subject && a.live), agent = account?.agents.find(a => a.id === op.agentId && a.live);
      if (!agent) throw new Refused('Owned live agent required');
      if (op.name !== undefined) agent.name = op.name;
      if (op.journeys !== undefined) agent.journeys = op.journeys;
      return { kind: 'ok' };
    }
    case 'code': {
      const pending = db.requests.find(r => r.id === op.id), account = state.accounts.find(a => a.subject === op.subject && a.live);
      const agent = account?.agents.find(a => a.id === op.agentId && a.live);
      if (!pending || !account || !agent || agent.pendingConsentId !== op.id || agent.clientId !== pending.request.clientId) throw new Refused('Authorization expired');
      agent.authorizationPending = false; delete agent.pendingConsentId;
      const code = randomToken();
      db.codes.push({ hash: await tokenHash(code), subject: account.subject, personId: account.personId, clientId: pending.request.clientId,
        agentId: agent.id, redirectUri: pending.request.redirectUri, challenge: pending.request.challenge, expiresAt: now + 60_000 });
      db.requests = db.requests.filter(r => r !== pending);
      return { kind: 'code', code };
    }
    case 'exchange': {
      const hash = await tokenHash(op.code), code = db.codes.find(c => c.hash === hash);
      if (!code || code.clientId !== op.clientId || code.redirectUri !== op.redirectUri || code.challenge !== await tokenHash(op.verifier) || !live(code)) return invalid();
      db.codes = db.codes.filter(c => c !== code);
      return issue(code);
    }
    case 'refresh': {
      const hash = await tokenHash(op.token), t = db.refresh.find(t => t.hash === hash);
      if (!t || t.clientId !== op.clientId) return invalid();
      if (t.used) { revokeFamily(t.family); return invalid(); }
      if (!live(t)) { revokeFamily(t.family); return invalid(); }
      t.used = true;
      return issue(t, t.family, t.expiresAt);
    }
    case 'verify': {
      const hash = await tokenHash(op.token), t = db.access.find(t => t.hash === hash);
      if (!t || !live(t)) return { kind: 'error', error: 'invalid_token' };
      return { kind: 'access', identity: { subject: t.subject, personId: t.personId, clientId: t.clientId, agentId: t.agentId }, expiresAt: t.expiresAt };
    }
    case 'revoke': {
      const hash = await tokenHash(op.token), t = [...db.access, ...db.refresh].find(t => t.hash === hash && t.clientId === op.clientId);
      if (t) revokeFamily(t.family);
      return { kind: 'ok' };
    }
  }
}
