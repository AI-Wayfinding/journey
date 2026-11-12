import * as z from 'zod';
import { base64url } from '../agents.ts';
import { Refused } from '../commands.ts';
import type { ConsoleConfig } from './contract.ts';
import { ConsoleSessions, SESSION_COOKIE, OAUTH_COOKIE, random, cookie } from './session.ts';
const SIGNED_OUT_COOKIE = '__Host-wayfinding-signed-out';

import { workspacePage } from './workspace.ts';
import { home, agentPage, passkeysPage, confirmation, journeyPage, routeId } from './pages.ts';
import { setupPage, profilePage } from './setup.ts';
import { style as baseStyle, webauthn, landingStyle } from './assets.ts';
const style = baseStyle + landingStyle;
import { parseCommand } from '../commands.ts';
import { formBody } from './forms.ts';
import { landingPage } from './landing.ts';
import { changeSchema, assertionSchema } from '../agents.ts';
import { registration } from './contract.ts';
import { browserPost } from './browser-api.ts';
import { browserBundle,browserIntegrity,browserPath,webauthnIntegrity } from '../../../browser/generated/bundle.ts';

const STATUS = '<p id="status" role="status" aria-live="polite"></p>';
const offerSettingsForm = (body: Record<string, unknown>) => ({
  publishWithoutReview: typeof body.publishWithoutReview === 'boolean' ? body.publishWithoutReview : z.enum(['true', 'false']).parse(body.publishWithoutReview) === 'true',
  maxAdmission: z.enum(['hold', 'allow']).parse(body.maxAdmission),
  maxRequestsPerDay: z.coerce.number().int().min(0).max(1000).parse(body.maxRequestsPerDay),
});
export function createConsole(config: ConsoleConfig) {
  const origin = config.resource.origin, clientId = `${origin}/console/client.json`, redirectUri = `${origin}/console/callback`;
  const now = config.now ?? Date.now, send = config.send ?? fetch.bind(globalThis);
  const tokenEndpoint = new URL('/oauth2/token', config.issuer);
  if (tokenEndpoint.protocol !== 'https:') throw new Refused('HTTPS AuthKit issuer required');
  const sessions = new ConsoleSessions(config.backend, config.secret, origin, now);
  // same-origin (not no-referrer): with no-referrer, browsers send `Origin: null` on form posts and the origin check refuses them.
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; style-src 'self'; script-src '${webauthnIntegrity}' '${browserIntegrity}'; connect-src 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` };
  const redirect = (location: string, cookies: string[] = []) => {
    const h = new Headers({ ...headers, Location: location });
    for (const c of cookies) h.append('Set-Cookie', c);
    return new Response(null, { status: 303, headers: h });
  };
  return { async fetch(request: Request): Promise<Response> {
    if (new TextEncoder().encode(config.secret).length < 32) return new Response('Console secret is not configured', { status: 503, headers });
    try {
      const url = new URL(request.url), path = url.pathname;
      if (!['GET', 'POST'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
      if (request.method === 'GET' && path === '/') {
        const html = (text: string) => new Response(text, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
        const record = await sessions.read(request, SESSION_COOKIE);
        if (record?.kind !== 'session') return html(landingPage({ signedIn: false }, config.resource.href));
        try {
          const account = await config.backend.execute(record.subject, { tool: 'account_read', input: {} }, record.clientId);
          if(config.backend.sealedMode && !(await config.backend.passkey({subject:record.subject,clientId:record.clientId},{op:'setup_status'})).complete)return redirect('/console/onboarding');
          const name = String(account.nickname ?? account.name ?? account.email ?? 'Your account');
          return html(landingPage({ signedIn: true, name, csrf: record.csrf }, config.resource.href));
        } catch { return html(landingPage({ signedIn: false }, config.resource.href)); }
      }
      if (request.method === 'GET' && path === '/console/style.css') return new Response(style, { headers: { ...headers, 'Content-Type': 'text/css; charset=utf-8' } });
      if(request.method==='GET'&&path===browserPath&&config.backend.sealedMode)return new Response(browserBundle,{headers:{...headers,'Content-Type':'text/javascript; charset=utf-8'}});
      if (request.method === 'GET' && path === '/console/webauthn.js') return new Response(webauthn, { headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' } });
      if (request.method === 'GET' && path === '/console/client.json') return Response.json({ client_id: clientId, client_name: 'Wayfinding console',
        redirect_uris: [redirectUri], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }, { headers });
      if (request.method === 'GET' && path === '/console/login') {
        const state = random(), verifier = random();
        const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        const destination = new URL('/oauth2/authorize', config.issuer);
        destination.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile email',
          resource: config.resource.href, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
        // After sign-out, ask AuthKit to show its sign-in page; otherwise its own session signs the person straight back in.
        destination.searchParams.set('prompt', 'login');
        const returnTo = url.searchParams.get('return_to');
        if (returnTo !== null && !/^\/oauth\/consent\?request=[A-Za-z0-9_-]{43}$/.test(returnTo)) throw new Refused('Invalid sign-in return');
        const response = redirect(destination.href, [await sessions.create(OAUTH_COOKIE, { kind: 'oauth', state, verifier, ...(returnTo ? { returnTo } : {}), expiresAt: now() + 600_000 })]);
        return new Response(null, { status: 302, headers: response.headers });
      }
      if (request.method === 'GET' && path === '/console/callback') {
        const pending = await sessions.read(request, OAUTH_COOKIE, 'take');
        if (pending?.kind !== 'oauth' || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== pending.state) throw new Refused('OAuth state refused');
        const code = z.string().min(1).max(4096).parse(url.searchParams.get('code'));
        if (url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error')) throw new Refused('OAuth code refused');
        const response = await send(tokenEndpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId,
            redirect_uri: redirectUri, code_verifier: pending.verifier, resource: config.resource.href }).toString() });
        if (!response.ok) throw new Refused('Sign-in exchange refused');
        const result = z.object({ access_token: z.string().min(1).max(16384), token_type: z.string() }).parse(await response.json());
        if (result.token_type.toLowerCase() !== 'bearer') throw new Refused('Bearer token required');
        const auth = await config.verifier.verifyAccessToken(result.access_token), subject = auth.extra?.['sub'];
        if (auth.clientId !== clientId || typeof subject !== 'string') throw new Refused('Only the console client may sign in');
        await config.backend.execute(subject, { tool: 'account_read', input: {} }, clientId);
        await sessions.consumeLogin(request);
        return redirect(pending.returnTo ?? '/console', [await sessions.create(SESSION_COOKIE, { kind: 'session', subject, clientId, csrf: random(), signedInAt: now(), expiresAt: now() + 28_800_000 }), cookie(OAUTH_COOKIE, '', 0), cookie(SIGNED_OUT_COOKIE, '', 0)]);
      }
      // A page visit without a valid session goes to sign-in; POSTs stay refused.
      if (request.method === 'GET' && (await sessions.read(request, SESSION_COOKIE))?.kind !== 'session') return redirect('/console/login');
      const session = await sessions.require(request);
      const setup = config.backend.sealedMode ? await config.backend.passkey({subject:session.subject,clientId:session.clientId},{op:'setup_status'}) : {complete:true};
      const waiting=typeof setup.readyAt==='number'&&setup.readyAt>now();
      const setupPaths=['/console/onboarding','/console/logout','/console/passkeys/options','/console/passkeys/register','/console/passkeys/addition-options','/console/setup/options','/console/setup/complete','/console/connections/register','/console/recovery/start'];
      if(!setup.complete && !(setupPaths.includes(path)||(!waiting&&['/console/device/identity','/console/device/info','/console/device/enroll/options','/console/device/enroll/finish','/console/device/call'].includes(path)))) {
        if(request.method==='GET')return redirect('/console/onboarding');
        throw new Refused('Complete onboarding before using the console');
      }
      if(waiting&&request.method==='POST'&&!['/console/logout','/console/recovery/start'].includes(path))throw new Refused('Wait the full 72 hours');
      if(typeof setup.readyAt==='number'&&setup.readyAt<=now()&&request.method==='POST'&&!['/console/logout','/console/recovery/start'].includes(path)&&(session.signedInAt===undefined||session.signedInAt<setup.readyAt))return redirect('/console/login');
      if (request.method === 'POST') {
        const body = await formBody(request, session.csrf, origin, path==='/console/device/call'?15*1024*1024:96*1024), identity = { subject: session.subject, clientId: session.clientId, signedInAt: session.signedInAt };
        if (path === '/console/logout') {
          await sessions.read(request, SESSION_COOKIE, 'delete');
          // Land on the signed-out home page: /console/login would bounce through AuthKit, whose own session signs the person straight back in.
          return redirect('/', [cookie(SESSION_COOKIE, '', 0), cookie(SIGNED_OUT_COOKIE, '1', 600)]);
        }
        if(path==='/console/recovery/start'){
          if(body.confirm!=='REMOVE ALL CONNECTIONS')throw new Refused('Confirm removal of all connections');
          await config.backend.passkey(identity,{op:'recovery_start'});return redirect('/console/onboarding');
        }
        if(path==='/console/connections/register')return Response.json(await config.backend.passkey(identity,{op:'finish',credential:registration.parse(body.credential)}),{headers});
        if(path==='/console/connections/remove'){
          await browserPost(config.backend,identity,'/console/device/revoke',{csrf:session.csrf,browserId:body.browserId});return redirect('/console');
        }
        if(path==='/console/setup/options'||path==='/console/setup/complete')return Response.json(await config.backend.passkey(identity,{op:path.endsWith('/options')?'setup_options':'setup_complete',browserId:z.string().uuid().parse(body.browserId),recoveryProof:z.string().parse(body.recoveryProof),...(body.assertion?{assertion:body.assertion}:{})}),{headers});
        if(config.backend.sealedMode&&path==='/console/device/call'){
          try{return Response.json(await browserPost(config.backend,identity,path,body,now()),{headers});}
          catch(error){
            if(error instanceof Refused)return Response.json({error:error.message},{status:409,headers});
            if(error instanceof z.ZodError)return Response.json({error:'Invalid browser tool input'},{status:400,headers});
            return Response.json({error:'Coordination operation failed'},{status:500,headers});
          }
        }
        if(config.backend.sealedMode&&path.startsWith('/console/device/'))return Response.json(await browserPost(config.backend,identity,path,body,now()),{headers});
        if(path==='/console/passkeys/addition-options')return Response.json(await config.backend.passkey(identity,{op:'addition_options'}),{headers});
        if (path === '/console/passkeys/options') {
          const keys=await config.backend.passkey(identity,{op:'list'});
          if(z.array(z.unknown()).parse(keys.passkeys).length===0&&(session.signedInAt===undefined||session.signedInAt>now()||now()-session.signedInAt>600000))throw new Refused('Sign in again before creating your first passkey');
          return Response.json(await config.backend.passkey(identity,{op:'begin',...(body.assertion?{assertion:body.assertion}:{}),...(body.recoveryProof?{recoveryProof:z.string().parse(body.recoveryProof)}:{})}),{headers});
        }
        if (path === '/console/passkeys/register') {
          await config.backend.passkey(identity, { op: 'finish', credential: registration.parse(body.credential) });
          return redirect('/console/passkeys?notice=registered');
        }
        if (path === '/console/passkeys/rename') {
          await config.backend.passkey(identity, { op: 'rename', id: z.string().min(1).max(2048).parse(body.id), name: z.string().max(60).parse(body.name ?? '') });
          return redirect('/console/passkeys?notice=renamed');
        }
        if (path === '/console/passkeys/delete') {
          await config.backend.passkey(identity, { op: 'delete', id: z.string().min(1).max(2048).parse(body.id) });
          return redirect('/console/passkeys');
        }
        if (path === '/console/authorize/options' || path === '/console/authorize/complete') {
          const change = changeSchema.parse(body.change);
          if (change.kind !== 'card' && change.kind !== 'offer_settings') throw new Refused('Client binding is managed at sign-in');
          if (path.endsWith('/options')) {
            const keys = await config.backend.passkey(identity, { op: 'list' });
            const credentials = z.array(z.object({ id: z.string() })).parse(keys.passkeys);
            if (!credentials.length) return Response.json({ error: 'Add a passkey first: open Passkeys, add one, then come back and confirm.' }, { status: 409, headers });
            const { challenge } = await config.backend.beginAuthorization(identity, change);
            return Response.json({ challenge, rpId: 'poc.wayfinding.support', userVerification: 'required', timeout: 60000,
              allowCredentials: credentials.map(c => ({ type: 'public-key', id: c.id })) }, { headers });
          }
          await config.backend.completeAuthorization(identity, change, assertionSchema.parse(body.assertion));
          return redirect(`/console/agents/${encodeURIComponent(change.agentId)}?notice=confirmed`);
        }
        if (path === '/console/authorize/start') {
          const change = changeSchema.parse(body.kind === 'card' ? { kind: body.kind, agentId: body.agentId, capabilities: body.capabilities ?? [] }
            : body.kind === 'offer_settings' ? { kind: body.kind, agentId: body.agentId, settings: offerSettingsForm(body) }
            : { kind: body.kind, clientId: body.clientId, agentId: body.agentId });
          if (change.kind !== 'card' && change.kind !== 'offer_settings') throw new Refused('Client binding is managed at sign-in');
          const agent = await config.backend.execute(session.subject, parseCommand('agent_capabilities', { agentId: change.agentId }), session.clientId);
          return new Response(confirmation(change, session.csrf, String(agent.name)), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
        }
        if (path === '/console/journeys/join') {
          await config.backend.execute(session.subject, parseCommand('journey_join', { journeyId: body.journeyId }), session.clientId);
          return redirect('/console?notice=joined');
        }
        if (path === '/console/agents/update') {
          const agentId = z.string().min(1).max(200).parse(body.agentId);
          await config.backend.manageAgent(identity, agentId, z.string().trim().min(1).max(60).parse(body.name), z.array(z.string().min(1).max(200)).max(128).parse(body.journeys ?? []));
          return redirect(`/console/agents/${encodeURIComponent(agentId)}`);
        }
        if (path === '/console/offers/settings') {
          const agentId = z.string().min(1).max(200).parse(body.agentId);
          await config.backend.execute(session.subject, parseCommand('offer_settings', { agentId, ...offerSettingsForm(body) }), session.clientId);
          return redirect(`/console/agents/${encodeURIComponent(agentId)}`);
        }
        if (path === '/console/offers/journey') {
          const agentId = z.string().min(1).max(200).parse(body.agentId);
          const limitMode = z.enum(['inherit', 'limit']).parse(body.limitMode);
          const enabled = typeof body.enabled === 'boolean' ? body.enabled : z.enum(['true', 'false']).parse(body.enabled) === 'true';
          await config.backend.execute(session.subject, parseCommand('offer_journey_set', {
            agentId, offerId: body.offerId, journeyId: body.journeyId, expectedVersion: z.coerce.number().int().min(1).parse(body.expectedVersion), enabled,
            ...(limitMode === 'inherit' ? { clearLimit: true } : { maxRequestsPerDay: z.coerce.number().int().min(1).max(1000).parse(body.maxRequestsPerDay) }),
          }), session.clientId);
          return redirect(`/console/agents/${encodeURIComponent(agentId)}`);
        }
        if (path === '/console/offers/publish' || path === '/console/offers/retire') {
          if(config.backend.sealedMode&&path.endsWith('/publish'))throw new Refused('Use your unlocked browser connection to publish sealed offers with their journey settings');
          const agentId = z.string().min(1).max(200).parse(body.agentId);
          await config.backend.execute(session.subject, parseCommand(path.endsWith('/publish') ? 'offer_publish' : 'offer_retire', { agentId, offerId: body.offerId }), session.clientId);
          return redirect(`/console/agents/${encodeURIComponent(agentId)}`);
        }
        if (path === '/console/offers/rule-remove') {
          const agentId = z.string().min(1).max(200).parse(body.agentId), offerId = z.string().min(1).max(200).parse(body.offerId);
          const ruleIndex = z.coerce.number().int().min(0).max(49).parse(body.ruleIndex);
          const version = z.coerce.number().int().min(1).parse(body.version);
          const listed = await config.backend.execute(session.subject, parseCommand('offer_list', { agentId }), session.clientId);
          const offers = z.array(z.record(z.string(), z.unknown())).parse(listed.offers);
          const offer = offers.find(o => o.id === offerId);
          if (!offer || offer.version !== version) throw new Refused('Offer changed; reload before removing a rule');
          const admission = z.object({ rules: z.array(z.record(z.string(), z.unknown())), default: z.enum(['allow', 'hold', 'deny']) }).parse(offer.admission);
          const rule = admission.rules[ruleIndex];
          if (!rule || typeof rule.who !== 'object' || rule.who === null) throw new Refused('Standing rule required');
          await config.backend.execute(session.subject, parseCommand('offer_set', { agentId, expectedVersion: version, offer: {
            id: offer.id, name: offer.name, description: offer.description, tags: offer.tags, examples: offer.examples,
            inputSchema: offer.inputSchema, outputSchema: offer.outputSchema, journeySettings: offer.journeySettings, resource: offer.resource, instructions: offer.instructions,
            admission: { rules: admission.rules.filter((_, i) => i !== ruleIndex), default: admission.default },
          } }), session.clientId);
          return redirect(`/console/agents/${encodeURIComponent(agentId)}`);
        }
        if (path === '/console/offers/decide') {
          if (config.backend.sealedMode) throw new Refused('Use your unlocked browser connection to decide sealed requests');
          const agentId = z.string().min(1).max(200).parse(body.agentId);
          const action = z.enum(['approve', 'decline']).parse(body.action);
          await config.backend.execute(session.subject, parseCommand('task_step', {
            journeyId: body.journeyId, taskId: body.taskId, action,
            standing: body.standing, reason: action === 'decline' ? body.reason : undefined,
          }), session.clientId);
          return redirect(`/console/agents/${encodeURIComponent(agentId)}`);
        }
        if (['/console/agents/narrow', '/console/agents/remove'].includes(path)) {
          const tool = path.endsWith('/narrow') ? 'agent_narrow' : 'agent_remove';
          const input = tool === 'agent_narrow' ? { agentId: body.agentId, remove: body.capabilities ?? [] } : { agentId: body.agentId };
          await config.backend.execute(session.subject, parseCommand(tool, input), session.clientId);
          return redirect('/console');
        }
        return new Response('Not found', { status: 404, headers });
      }
      const identity = { subject: session.subject, clientId: session.clientId };
      // A fixed notice after a redirect (never caller text) tells the person their passkey was just used or changed.
      const notices: Record<string, string> = { confirmed: 'Confirmed with your passkey.', registered: 'Passkey added.', renamed: 'Passkey name saved.', joined: 'You joined the journey.' };
      const notice = notices[url.searchParams.get('notice') ?? ''];
      const html = (text: string) => {
        text=text.replace('<script src="/console/webauthn.js" defer></script>',`<script src="/console/webauthn.js" integrity="${webauthnIntegrity}" crossorigin="anonymous" defer></script>`);
        if(config.backend.sealedMode)text=text.replace('</head>',`<script type="module" src="${browserPath}" integrity="${browserIntegrity}" crossorigin="anonymous"></script></head>`).replace(/<p role="note">Proof of concept\.[\s\S]*?<\/p>/,'<p role="note">Synthetic data only. Content is sealed on your devices. Unlock this browser to read or write it. No key escrow: losing all devices and recovery material loses content. The hosted page can be replaced by its operator; this PoC does not protect against that.</p>');
        return new Response(notice ? text.replace(STATUS, `<p id="status" role="status" aria-live="polite" class="notice">${notice}</p>`) : text,{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
      };

      if(path==='/console/onboarding')return html(setupPage(session.csrf,setup,now()));
      if(path==='/console/profile')return html(profilePage(session.csrf,setup));
      if(path==='/console/recover')return html(setupPage(session.csrf,setup,now(),true));
      if (path === '/console' || path === '/console/') return html(await home(config.backend, identity, session.csrf));
      if (path === '/console/passkeys') return html(await passkeysPage(config.backend, identity, session.csrf));
      if (path.startsWith('/console/agents/')) return html(await agentPage(config.backend, identity, routeId(path, '/console/agents/'), session.csrf));
      const workspace = await workspacePage(config.backend, identity, url, session.csrf);
      if (workspace !== undefined) return html(workspace);
      if (path.startsWith('/console/journeys/')) return html(await journeyPage(config.backend, identity, routeId(path, '/console/journeys/'), session.csrf));
      return new Response('Not found', { status: 404, headers });
    } catch (error) {
      // Log the refusal reason only (no tokens or cookies) so live sign-in failures can be diagnosed.
      console.warn('console refused', config.backend.sealedMode?'sealed request':new URL(request.url).pathname, config.backend.sealedMode?'refused':error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'unknown');
      return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Console request refused</title><main><h1>Console request refused</h1><p>Check the form or <a href="/console/login">sign in to your console</a>.</p></main></html>', { status: 403, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
    }
  } };
}
