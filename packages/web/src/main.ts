import * as age from 'age-encryption';
import { EXPIRED_LINK } from './messages.js';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { newId, signEntry, verifyLog, wrapJourneyKey } from '@ai-wayfinding/core';
import type { CommentBody, ItemBody, ProtocolRecord } from '@ai-wayfinding/core';
import { clearPersonKeys, getPersonKeys, onPersonKeysCleared, sealPersonKeys, unlockPersonKeys } from './keys.js';
import type { PersonKeys } from './keys.js';
import { allRecords, api, appendEntry, createJourney, currentKey, encryptedEntry, exportEncrypted, itemVersions, letIn, listings, removeMember, rotatePending, saveRecord, verifiedJourney } from './journey.js';
import type { JourneyContext, JourneyListing } from './journey.js';
import './style.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
// This is only an invitation request token, never a person or journey key. It survives the email-link navigation in this tab.
const INVITE_FRAGMENT = 'wayfinding-invitation';
let email = '';
let requestedRoute = location.pathname + location.hash;
let recovery: { identity: string; recipient: string; wrap: string; listing: JourneyListing } | null = null;
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const input = (form: HTMLFormElement, name: string): string => String(new FormData(form).get(name) ?? '').trim();
const read = (name: string) => (root.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.value ?? '';
function render(content: string): void {
  root.innerHTML = `<header><a class="brand" href="/"><img src="/wayfinding-mark.svg" alt="" />Wayfinding <span>journeys</span></a><nav><a href="/">My journeys</a>${getPersonKeys() ? '<a href="/new">Start a journey</a><button class="secondary" id="logout">Sign out</button>' : '<a href="/sign-in">Sign in</a>'}</nav></header><main id="content">${content}</main>`;
  root.querySelector('#logout')?.addEventListener('click', () => perform(async () => { clearPersonKeys(); sessionStorage.removeItem(INVITE_FRAGMENT); email = ''; await api('/auth/logout', 'POST', {}); navigate('/sign-in'); }));
}
function error(message: string): void { const main = root.querySelector('main') ?? root; const box = document.createElement('p'); box.className = 'error'; box.setAttribute('role', 'alert'); box.textContent = message; main.prepend(box); }
function perform(action: () => Promise<void>): void { void action().catch(cause => error(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.')); }
function form(id: string, action: (form: HTMLFormElement) => Promise<void>): void {
  root.querySelector<HTMLFormElement>(`#${id}`)?.addEventListener('submit', event => { event.preventDefault(); const target = event.currentTarget as HTMLFormElement; const button = target.querySelector<HTMLButtonElement>('button[type=submit]'); if (button) button.disabled = true; perform(async () => { try { await action(target); } finally { if (button?.isConnected) button.disabled = false; } }); });
}
function copy(id: string): void { root.querySelector<HTMLButtonElement>(`#${id}`)?.addEventListener('click', () => perform(async () => { const value = root.querySelector<HTMLElement>(`#${id}-value`)?.textContent ?? ''; await navigator.clipboard.writeText(value); const status = root.querySelector<HTMLElement>('#copy-status'); if (status) status.textContent = 'Copied.'; })); }
function download(filename: string, content: string): void { const href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = href; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(href), 5000); }
function supportedPrfBrowser(): boolean {
  if (!('PublicKeyCredential' in window) || !navigator.credentials?.create) return false;
  const ua = navigator.userAgent;
  const chrome = /(?:Chrome|Edg)\/(\d+)/.exec(ua);
  const firefox = /Firefox\/(\d+)/.exec(ua);
  const safari = /Version\/(\d+)/.exec(ua);
  return chrome ? Number(chrome[1]) >= 116 : firefox ? Number(firefox[1]) >= 139 : safari ? Number(safari[1]) >= 18 : false;
}
async function passkeyConfirmation(): Promise<void> {
  const options = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/auth/passkey/login/options', 'POST', {});
  const response = await startAuthentication({ optionsJSON: options });
  await api('/auth/passkey/login/verify', 'POST', { response });
}
function signIn(destination = '/'): void {
  requestedRoute = destination === '/sign-in' ? '/' : destination;
  render(`<section class="panel"><p class="eyebrow">YOUR JOURNEY STARTS HERE</p><h1>Sign in</h1><p>Enter your email address. We'll send a private link to confirm it's you.</p><form id="email-form"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required /><div class="actions"><button type="submit">Send sign-in link</button></div></form></section>`);
  form('email-form', async f => { email = input(f, 'email'); await api('/auth/email/start', 'POST', { email, ...(/^\/agent-sessions\/[A-Za-z0-9_-]+$/.test(requestedRoute) ? { returnPath: requestedRoute } : {}) }); render('<section class="panel"><h1>Check your email</h1><p>Open the Wayfinding link to continue. It expires in 15 minutes. If you are joining a journey, keep this invitation open and return after signing in.</p></section>'); });
  // An already verified session can unlock this tab with PRF without another email link.
  void api<{ identity: string; signing: string } | null>('/me/keys').then(sealed => {
    if (!sealed || getPersonKeys() || !root.querySelector('#email-form')) return;
    render('<section class="panel"><h1>Unlock with your passkey</h1><p>Your keys are locked in this tab. Confirm your journey encryption passkey to continue.</p><div class="actions"><button id="unlock">Unlock with passkey</button></div></section>');
    root.querySelector('#unlock')?.addEventListener('click', () => perform(async () => { await unlockPersonKeys(sealed, new age.webauthn.WebAuthnIdentity({ rpId: location.hostname })); navigate(requestedRoute); }));
  }).catch(() => { /* No verified session: use the email form. */ });
}
async function verifyEmail(): Promise<void> {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('token');
  const next = fragment.get('next');
  const invitation = sessionStorage.getItem(INVITE_FRAGMENT);
  requestedRoute = next && /^\/agent-sessions\/[A-Za-z0-9_-]{1,128}$/.test(next) ? next : invitation && /^[A-Za-z0-9_-]{43,}$/.test(invitation) ? '/invite#' + invitation : '/';
  history.replaceState(null, '', '/auth/verify');
  if (!token) { signIn('/'); return; }
  let result: { challenge: 'register' | 'login' };
  try { result = await api<{ challenge: 'register' | 'login' }>('/auth/email/verify', 'POST', { token }); }
  catch { render(`<section class="panel"><h1>This sign-in link doesn't work</h1><p>${escape(EXPIRED_LINK)}</p><div class="actions"><a class="button" href="/sign-in">Send a new link</a></div></section>`); return; }
  if (result.challenge === 'register') {
    render(`<section class="panel"><h1>Create your passkeys</h1><p>Your passkeys protect your journey keys. You'll confirm a passkey for sign-in and one for encryption. No private key is saved on this device.</p><p>Works with Chrome or Edge 116+, Safari 18+, or Firefox 139+ with a passkey that supports PRF. There is no weaker fallback.</p><div class="actions"><button id="register">Register passkeys</button></div></section>`);
    const register = root.querySelector<HTMLButtonElement>('#register')!;
    if (!supportedPrfBrowser()) { register.disabled = true; error('This browser cannot use a PRF passkey. Use Chrome or Edge 116+, Safari 18+, or Firefox 139+ with a compatible passkey.'); return; }
    register.addEventListener('click', () => perform(async () => {
      register.disabled = true;
      const hint = await age.webauthn.createCredential({ keyName: 'Wayfinding journey encryption', rpId: location.hostname });
      const options = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('/auth/passkey/register/options', 'POST', {});
      const response = await startRegistration({ optionsJSON: options });
      if (response.clientExtensionResults?.prf?.enabled === false) throw new Error('This passkey cannot use PRF. Try a compatible passkey.');
      await api('/auth/passkey/register/verify', 'POST', { response });
      const sealed = await sealPersonKeys(new age.webauthn.WebAuthnRecipient({ identity: hint }));
      await api('/me/keys', 'PUT', sealed.sealed);
      await unlockPersonKeys(sealed.sealed, new age.webauthn.WebAuthnIdentity({ identity: hint }));
      navigate(requestedRoute);
    }));
  } else {
    render(`<section class="panel"><h1>Confirm your passkey</h1><p>After signing in, use your journey encryption passkey to unlock your keys in memory for this tab.</p><div class="actions"><button id="confirm">Sign in with passkey</button></div></section>`);
    root.querySelector('#confirm')?.addEventListener('click', () => perform(async () => {
      await passkeyConfirmation();
      const sealed = await api<{ identity: string; signing: string } | null>('/me/keys');
      if (!sealed) throw new Error('No encrypted keys were saved for this account. Ask for help before continuing.');
      await unlockPersonKeys(sealed, new age.webauthn.WebAuthnIdentity({ rpId: location.hostname }));
      navigate(requestedRoute);
    }));
  }
}
async function requireKeys(): Promise<PersonKeys | null> { const keys = getPersonKeys(); if (!keys) { signIn(requestedRoute || location.pathname + location.hash); return null; } return keys; }
async function home(): Promise<void> {
  const keys = await requireKeys(); if (!keys) return;
  const rows = await listings();
  const checked: JourneyListing[] = [];
  for (const row of rows) { const ctx = await verifiedJourney(row.id, row.principal, keys); checked.push({ id: row.id, principal: row.principal, name: String(ctx.log[0]?.body.name ?? row.name) }); }
  render(`<section class="panel"><p class="eyebrow">YOUR JOURNEYS</p><h1>A place to find your way</h1><p>Only people you invite can read what's inside.</p><div class="actions"><a class="button" href="/new">Start a journey</a></div></section><section class="panel"><h2>Journeys</h2>${checked.length ? `<ul class="list">${checked.map(row => `<li><a href="/journeys/${escape(row.id)}">${escape(row.name)}</a></li>`).join('')}</ul>` : '<p>No journeys yet. Start one when you are ready.</p>'}</section><section class="panel"><h2>Have an invitation?</h2><p>If you signed in from an invitation, paste the link here after you confirm your passkey.</p><form id="join-link"><label for="invite-link">Invitation link</label><input id="invite-link" name="invite-link" type="url" placeholder="https://app.wayfinding.support/invite#…" required /><div class="actions"><button type="submit">Open invitation</button></div></form></section>`);
  form('join-link', async f => { const url = new URL(input(f, 'invite-link')); if (url.origin !== location.origin || url.pathname !== '/invite' || !/^[A-Za-z0-9_-]{43,}$/.test(url.hash.slice(1))) throw new Error('This is not a Wayfinding invitation link.'); navigate('/invite' + url.hash); });
}
function newJourney(keys: PersonKeys): void {
  render(`<section class="panel"><p class="eyebrow">A NEW JOURNEY</p><h1>Start a journey</h1><form id="new-form"><label for="name">Journey name</label><input name="name" id="name" required maxlength="200" /><label for="kind">Who is it for?</label><select name="kind" id="kind"><option value="individual">Individual</option><option value="team">Team</option></select><label for="description">Description (optional)</label><textarea name="description" id="description" placeholder="What brings you here?"></textarea><p class="meta">The server keeps the journey name and your email address. The description is encrypted inside your journey.</p><label for="creator-email">Your email address</label><input name="creator-email" id="creator-email" type="email" autocomplete="email" value="${escape(email)}" required /><div class="actions"><button type="submit">Create journey</button></div></form></section>`);
  form('new-form', async f => {
    const result = await createJourney(input(f, 'name'), input(f, 'creator-email'), input(f, 'description'), input(f, 'kind') as 'individual' | 'team', keys);
    recovery = { identity: result.recoveryIdentity, recipient: result.recoveryRecipient, wrap: result.recoveryWrap, listing: result.listing };
    history.replaceState(null, '', `/journeys/${result.listing.id}/recovery`);
    recoveryScreen();
  });
}
function recoveryScreen(): void {
  if (!recovery) { render('<section class="panel"><h1>Recovery key unavailable</h1><p>Your recovery key is shown only once, when you start the journey. We cannot recover it for you.</p></section>'); return; }
  render(`<section class="panel"><p class="eyebrow">SAVE THIS NOW</p><h1>Your recovery key</h1><p class="error">Anyone with this key can read this journey. We can't recover it for you.</p><p>Save both lines together. This is the only time we show the key.</p><p>This key opens what the journey holds until its first key change, when someone is removed. After that, make an export from the journey page and keep it with this key.</p><pre id="recovery-copy-value">${escape(recovery.identity)}\n${escape(recovery.wrap)}</pre><div class="actions"><button id="recovery-copy" class="secondary">Copy</button><button id="recovery-download" class="secondary">Download as text file</button></div><p id="copy-status" role="status"></p><label class="checkbox" for="saved"><input type="checkbox" id="saved" /> I have saved my recovery key somewhere safe.</label><button id="continue" disabled>Continue to journey</button></section>`);
  copy('recovery-copy');
  root.querySelector('#recovery-download')?.addEventListener('click', () => download('wayfinding-recovery.txt', `${recovery!.identity}\n${recovery!.wrap}\n`));
  root.querySelector<HTMLInputElement>('#saved')?.addEventListener('change', event => { root.querySelector<HTMLButtonElement>('#continue')!.disabled = !(event.target as HTMLInputElement).checked; });
  root.querySelector('#continue')?.addEventListener('click', () => perform(async () => {
    const saved = recovery!;
    const ctx = await context(saved.listing.id); if (!ctx) return;
    await saveRecord(ctx, { type: 'item', typeVersion: 1, body: { id: newId(), itemType: 'recovery', title: 'Recovery recipient', body: saved.recipient, author: ctx.principal, authoredBy: 'human', created: new Date().toISOString(), tags: [] } });
    recovery = null; navigate('/journeys/' + saved.listing.id);
  }));
}
async function context(id: string): Promise<JourneyContext | null> {
  const keys = await requireKeys(); if (!keys) return null;
  const listing = (await listings()).find(row => row.id === id);
  if (!listing) { render('<section class="panel"><h1>Journey unavailable</h1><p>You no longer have access to this journey.</p></section>'); return null; }
  const ctx = await verifiedJourney(id, listing.principal, keys);
  if (ctx.log.at(-1)?.type === 'member.remove' && ctx.state.grants[ctx.principal]?.includes('members.manage')) {
    try { await rotatePending(ctx); return verifiedJourney(id, listing.principal, keys); }
    catch { render('<section class="panel"><h1>Key update pending</h1><p>A person who manages people can complete it on the next visit.</p></section>'); return null; }
  }
  return ctx;
}
async function journeyHome(id: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  const records = await allRecords(ctx), items = itemVersions(records).filter(v => !v.deleted && v.item.itemType !== 'recovery');
  const readOnly = ctx.state.members[ctx.principal]?.member.scope === 'read';
  const name = String(ctx.log[0]?.body.name ?? 'Journey');
  render(`<section class="panel"><p class="eyebrow">JOURNEY</p><h1>${escape(name)}</h1>${ctx.log[0]?.body.description ? `<p>${escape(String(ctx.log[0].body.description))}</p>` : ''}<div class="actions">${readOnly ? '<p class="meta">Your access is read-only.</p>' : `<a class="button" href="/journeys/${id}/add">Add an item</a>`}<a class="button" href="/journeys/${id}/members">People &amp; agents</a><a class="button" href="/journeys/${id}/export">Export</a></div></section><section class="panel"><h2>Items</h2><div class="grid"><div><label for="filter">Filter by type</label><select id="filter"><option value="">All types</option>${[...new Set(items.map(v => v.item.itemType))].map(t => `<option value="${escape(t)}">${escape(t)}</option>`).join('')}</select></div><div><label for="search">Search your items</label><input id="search" type="search" placeholder="Search titles and text" /></div></div><div id="items" class="cards"></div></section>`);
  const showItems = () => { const filter = read('filter'), query = read('search').toLocaleLowerCase(); root.querySelector('#items')!.innerHTML = items.filter(({ item }) => (!filter || item.itemType === filter) && (!query || `${item.title} ${item.body}`.toLocaleLowerCase().includes(query))).map(({ item, root: itemRoot }) => `<article class="card"><p class="meta">${escape(item.itemType)}</p><h3><a href="/journeys/${id}/items/${escape(itemRoot)}">${escape(item.title)}</a></h3><p>${escape(item.body.slice(0, 160))}</p></article>`).join('') || '<p>No matching items.</p>'; };
  root.querySelector('#search')?.addEventListener('input', showItems); root.querySelector('#filter')?.addEventListener('change', showItems); showItems();
}
async function itemScreen(id: string, itemId: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  const view = itemVersions(await allRecords(ctx)).find(entry => entry.item.id === itemId || entry.versions.some(v => v.id === itemId));
  if (!view || view.deleted) throw new Error('Item not found.');
  const { item, versions, comments } = view;
  const readOnly = ctx.state.members[ctx.principal]?.member.scope === 'read';
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><p class="eyebrow">${escape(item.itemType)}</p><h1>${escape(item.title)}</h1><p class="meta">Tags: ${escape(item.tags.join(', ') || 'none')}</p><pre>${escape(item.body)}</pre>${readOnly ? '' : `<div class="actions"><a href="/journeys/${id}/items/${escape(itemId)}/edit" class="button">Edit item</a><button class="secondary" id="delete-item">Delete item</button></div>`}</section><section class="panel"><h2>Versions</h2><ul class="list">${versions.map(v => `<li><p class="meta">${escape(v.created)} · ${escape(v.authoredBy)}</p><pre>${escape(v.body)}</pre></li>`).join('')}</ul></section><section class="panel"><h2>Comments</h2><ul class="list">${comments.map(c => `<li><p class="meta">${escape(c.body.at)} · ${escape(c.body.author)}</p><p>${escape(c.body.body)}</p></li>`).join('')}</ul>${readOnly ? '<p>Your access is read-only.</p>' : `<form id="comment-form"><label for="comment">Add a comment</label><textarea id="comment" name="comment" required></textarea><div class="actions"><button type="submit">Add comment</button></div></form>`}</section>`);
  form('comment-form', async f => { const body: CommentBody = { id: newId(), item: itemId, onVersion: item.id, author: ctx.principal, authoredBy: 'human', at: new Date().toISOString(), body: input(f, 'comment') }; await saveRecord(ctx, { type: 'comment', typeVersion: 1, body }); await itemScreen(id, itemId); });
  root.querySelector('#delete-item')?.addEventListener('click', () => perform(async () => { if (!confirm('Delete this item? Its encrypted versions remain in the journey history.')) return; await saveRecord(ctx, { type: 'delete', typeVersion: 1, body: { target: itemId } }); navigate(`/journeys/${id}`); }));
}
async function itemForm(id: string, itemId?: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  if (ctx.state.members[ctx.principal]?.member.scope === 'read') throw new Error('This journey is read-only for you.');
  const previous = itemId ? itemVersions(await allRecords(ctx)).find(v => v.versions.some(item => item.id === itemId)) : null;
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><h1>${previous ? 'Edit item' : 'Add an item'}</h1><form id="item-form"><label for="item-type">Type</label><select id="item-type" name="item-type">${['note','decision','question','learning','tension','practice','success','resource'].map(t => `<option value="${t}" ${previous?.item.itemType === t ? 'selected' : ''}>${t}</option>`).join('')}</select><label for="item-title">Title</label><input id="item-title" name="item-title" value="${escape(previous?.item.title ?? '')}" required /><label for="item-body">Body (Markdown as plain text)</label><textarea id="item-body" name="item-body">${escape(previous?.item.body ?? '')}</textarea><label for="tags">Tags (comma-separated)</label><input id="tags" name="tags" value="${escape(previous?.item.tags.join(', ') ?? '')}" /><label for="authored-by">Authored by</label><select id="authored-by" name="authored-by"><option value="human" selected>Person</option><option value="mixed">Person and agent</option><option value="agent">Agent</option></select><div class="actions"><button type="submit">Save item</button></div></form></section>`);
  form('item-form', async f => {
    const body: ItemBody = { id: newId(), itemType: input(f, 'item-type'), title: input(f, 'item-title'), body: input(f, 'item-body'), author: ctx.principal, authoredBy: input(f, 'authored-by') as ItemBody['authoredBy'], created: new Date().toISOString(), tags: input(f, 'tags').split(',').map(s => s.trim()).filter(Boolean), ...(previous ? { replaces: previous.item.id } : {}) };
    await saveRecord(ctx, { type: 'item', typeVersion: 1, body }); navigate(`/journeys/${id}/items/${previous ? itemId : body.id}`);
  });
}

async function membersScreen(id: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  const pendingRotation = ctx.log.at(-1)?.type === 'member.remove';
  const holder = ctx.state.grants[ctx.principal]?.includes('members.manage') ?? false;
  const pending = holder ? (await api<{ pending: { principal: string; recipient: string; signingKey: string; support: number; expires: number | null }[] }>(`/journeys/${id}/invites/pending`, 'GET', undefined, ctx.principal)).pending : [];
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><h1>People &amp; agents</h1><p>Only journey members can see who is here. People who manage members are marked below.</p>${pendingRotation ? '<p class="notice">Key update pending. A person who manages members can finish it on their next visit.</p>' : ''}<ul class="list">${Object.entries(ctx.state.members).map(([memberId, { member, grants }]) => `<li><strong>${member.kind === 'agent' ? 'Agent' : member.support ? 'Wayfinding support (Hypha)' : 'Person'} ${memberId === ctx.principal ? '(you)' : escape(memberId)}</strong><p class="meta">${grants.includes('members.manage') ? 'Manages people' : 'Member'}${member.kind === 'agent' || member.support ? ` · ${escape(member.scope ?? 'readwrite')} · ${escape(member.expiresAt ?? 'session')}` : ''}</p>${holder && memberId !== ctx.principal ? `<div class="actions"><button class="secondary" data-remove="${escape(memberId)}">Remove</button>${member.kind === 'person' && !member.support ? `<button class="secondary" data-grant="${escape(memberId)}">${grants.includes('members.manage') ? 'Stop managing people' : 'Let manage people'}</button>` : ''}</div>` : ''}</li>`).join('')}</ul><div class="actions"><button id="leave" class="secondary">Leave journey</button></div></section>${holder ? `<section class="panel"><h2>Invite someone</h2><form id="invite-form"><label for="invite-scope">Invitation</label><select id="invite-scope" name="invite-scope"><option value="person">Invite a person</option><option value="support">Invite Wayfinding support</option></select><p class="meta">Support joins like any other person. Their access ends after seven days.</p><div class="actions"><button type="submit">Create invitation link</button></div></form><div id="invitation"></div></section><section class="panel"><h2>Waiting to join</h2><ul class="list">${pending.length ? pending.map(row => `<li><code>${escape(row.principal)}</code>${row.support ? ' · Wayfinding support (Hypha), read only' : ''} <button data-let-in="${escape(row.principal)}">Let in</button></li>`).join('') : '<li>No one is waiting.</li>'}</ul></section>` : ''}`);
  const fresh = async () => { const latest = await context(id); if (!latest) throw new Error('Sign in again.'); return latest; };
  form('invite-form', async f => {
    await fresh();
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
    const inviteIdHash = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await api(`/journeys/${id}/invites`, 'POST', { inviteIdHash, expiresAt: Date.now() + 7 * 86_400_000, support: input(f, 'invite-scope') === 'support' }, ctx.principal);
    const value = `${location.origin}/invite#${secret}`;
    root.querySelector('#invitation')!.innerHTML = `<p class="notice">Share this invitation once. It expires in seven days. Anyone with this link can ask to join; a member must let them in.</p><pre id="invite-copy-value">${escape(value)}</pre><button id="invite-copy">Copy link</button><p id="copy-status" role="status"></p>`;
    copy('invite-copy');
  });
  root.querySelectorAll<HTMLButtonElement>('[data-let-in]').forEach(button => button.addEventListener('click', () => perform(async () => { const latest = await fresh(); const person = pending.find(row => row.principal === button.dataset.letIn); if (!person) throw new Error('This person is no longer waiting.'); await letIn(latest, person); await membersScreen(id); })));
  root.querySelectorAll<HTMLButtonElement>('[data-grant]').forEach(button => button.addEventListener('click', () => perform(async () => { const latest = await fresh(); const target = button.dataset.grant!; const grants = latest.state.grants[target] ?? []; await appendEntry(latest, grants.includes('members.manage') ? 'grant.remove' : 'grant.add', { member: target, grant: 'members.manage' }); await membersScreen(id); })));
  root.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button => button.addEventListener('click', () => perform(async () => {
    const latest = await fresh(); const target = button.dataset.remove!;
    if (!confirm('This person loses access now, but keeps anything they already downloaded. Their agents go too. Continue?')) return;
    await passkeyConfirmation();
    await removeMember(latest, target).catch(cause => { error('Key update pending. A member who manages people can complete it on the next visit.'); throw cause; });
    await membersScreen(id);
  })));
  root.querySelector('#leave')?.addEventListener('click', () => perform(async () => {
    const latest = await fresh();
    if (!confirm('Leave this journey? You lose access now, but keep anything you already downloaded. Your agents go too.')) return;
    if (latest.state.grants[latest.principal]?.includes('members.manage') && Object.entries(latest.state.grants).filter(([memberId, grants]) => memberId !== latest.principal && grants.includes('members.manage')).length === 0) throw new Error('The last person who manages members cannot leave. Grant that role to someone else first.');
    await passkeyConfirmation();
    await appendEntry(latest, 'member.remove', { member: latest.principal }, { accessChanges: [{ principal: latest.principal, action: 'remove', kind: 'person', scope: 'readwrite' }] });
    navigate('/');
  }));
}

async function acceptInvite(): Promise<void> {
  const secret = location.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{43,}$/.test(secret)) throw new Error('This invitation link is incomplete. Ask the member to send it again.');
  const keys = getPersonKeys(); if (!keys) { sessionStorage.setItem(INVITE_FRAGMENT, secret); signIn('/invite#' + secret); return; }
  const lists = await listings();
  render(`<section class="panel"><h1>Join a journey</h1><p>A member will review your request before you can read anything.</p><div class="actions"><button id="accept">Ask to join</button></div></section>`);
  root.querySelector('#accept')?.addEventListener('click', () => perform(async () => {
    const principal = newId();
    const result = await api<{ journeyId: string }>('/invites/accept', 'POST', { inviteId: secret, principal: { id: principal, recipient: keys.recipient, signingKey: keys.signingKey } });
    sessionStorage.removeItem(INVITE_FRAGMENT);
    history.replaceState(null, '', '/invite');
    render(`<section class="panel"><h1>Waiting for a member to let you in</h1><p>This page checks for access automatically. Keep it open.</p><p id="wait-status" role="status"></p></section>`);
    const refresh = async () => {
      try { const row = (await listings()).find(j => j.id === result.journeyId && j.principal === principal); if (row) { await verifiedJourney(row.id, principal, keys); navigate('/journeys/' + row.id); return; } }
      catch { /* The member has not yet posted the complete signed log and wrap. */ }
      if (document.querySelector('#wait-status')) setTimeout(() => void refresh(), 4000);
    };
    void refresh();
  }));
  // The list is fetched only to check authentication; the invite fragment stays in memory.
  void lists;
}

async function agentScreen(sessionId: string): Promise<void> {
  const agent = await api<{ status: string; journeyId: string; principal: string; recipient: string; signingKey: string; requestedScope: 'read' | 'readwrite'; remembered: boolean }>(`/agent-sessions/${sessionId}`);
  const keys = getPersonKeys(); if (!keys) { signIn(`/agent-sessions/${sessionId}`); return; }
  if (agent.status !== 'pending') { render(`<section class="panel"><h1>Agent request ${escape(agent.status)}</h1></section>`); return; }
  const ctx = await context(agent.journeyId); if (!ctx) return;
  const hours = agent.remembered ? '<option value="8">8 hours</option><option value="168">7 days</option><option value="2160">90 days</option>' : '<option value="1">1 hour</option><option value="8">8 hours</option>';
  render(`<section class="panel"><h1>Approve an agent</h1><p>Check the six-digit code shown by the agent before granting access. Choose what it can do and for how long.</p><form id="agent-form"><label for="agent-code">Six-digit code</label><input id="agent-code" name="agent-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required /><label for="agent-scope">Access</label><select id="agent-scope" name="agent-scope"><option value="read">Read only</option><option value="readwrite">Read and write</option></select><label for="agent-hours">How long?</label><select id="agent-hours" name="agent-hours">${hours}</select><div class="actions"><button type="submit">Confirm with passkey</button></div></form></section>`);
  form('agent-form', async f => {
    await passkeyConfirmation();
    const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys);
    const scope = input(f, 'agent-scope') as 'read' | 'readwrite', expiresAt = Date.now() + Number(input(f, 'agent-hours')) * 3_600_000;
    const member = { id: agent.principal, kind: 'agent' as const, recipient: agent.recipient, signingKey: agent.signingKey, addedBy: ctx.principal, scope, expiresAt: new Date(expiresAt).toISOString() };
    const entry = await signEntry({ v: 1, seq: latest.state.lastSeq + 1, prev: latest.state.lastHash, at: new Date().toISOString(), actor: latest.principal, type: 'member.add', body: { member, grants: [], kind: 'agent' } }, latest.keys.signingPrivateKey);
    const verified = await verifyLog([...latest.log, entry]); if (!verified.ok) throw new Error(verified.error.message);
    const [wrap] = await wrapJourneyKey(currentKey(latest), [{ id: member.id, recipient: member.recipient }]);
    await api(`/agent-sessions/${sessionId}/approve`, 'POST', { code: input(f, 'agent-code'), principal: latest.principal, scope, expiresAt, wrap: wrap!.ciphertext, entry: await encryptedEntry(latest, entry) });
    render(`<section class="panel"><h1>Agent approved</h1><p>You can see it in your journey's people and agents list.</p><a href="/journeys/${latest.id}/members">People &amp; agents</a></section>`);
  });
}
async function exportScreen(id: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  const recipient = itemVersions(await allRecords(ctx)).find(v => v.item.itemType === 'recovery' && !v.deleted)?.item.body ?? '';
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><h1>Export your journey</h1><p>Your export contains the signed journey history, encrypted items and comments, and your key wraps. The download is encrypted to you and, by default, your recovery key. Save both to open it later.</p><form id="export-form"><label for="recovery-recipient">Recovery recipient (age public key)</label><input id="recovery-recipient" name="recovery-recipient" required placeholder="age1…" value="${escape(recipient)}" /><div class="actions"><button type="submit">Download encrypted export</button></div></form></section>`);
  form('export-form', async f => { const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys); const ciphertext = await exportEncrypted(latest, [ctx.keys.recipient, input(f, 'recovery-recipient')]); download(`wayfinding-${id}.age.txt`, ciphertext); });
}
function navigate(path: string): void {
  if (recovery && location.pathname.endsWith('/recovery') && path !== location.pathname) recovery = null;
  history.pushState(null, '', path); requestedRoute = path; perform(route);
}
onPersonKeysCleared(() => {
  recovery = null;
  if (root.querySelector('#content')) render('<section class="panel"><h1>Session locked</h1><p>Your keys have been cleared from this tab. Sign in again to continue.</p><a href="/sign-in">Sign in</a></section>');
});
root.addEventListener('click', event => { const link = (event.target as Element).closest('a[href]') as HTMLAnchorElement | null; if (link && link.origin === location.origin && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(link.pathname + link.hash); } });
window.addEventListener('popstate', () => perform(route));
window.addEventListener('pagehide', clearPersonKeys);
async function route(): Promise<void> {
  const path = location.pathname;
  if (path === '/auth/verify') return verifyEmail();
  if (path === '/sign-in') return signIn();
  if (path === '/invite') return acceptInvite();
  const agent = /^\/agent-sessions\/([A-Za-z0-9_-]+)$/.exec(path); if (agent) return agentScreen(agent[1]!);
  if (path === '/new') { const keys = await requireKeys(); if (keys) newJourney(keys); return; }
  const journey = /^\/journeys\/([0-7][0-9A-HJKMNP-TV-Z]{25})(?:\/(.*))?$/.exec(path);
  if (journey) {
    const id = journey[1]!, sub = journey[2] ?? '';
    if (sub === 'recovery') return recoveryScreen();
    if (sub === 'members') return membersScreen(id);
    if (sub === 'export') return exportScreen(id);
    if (sub === 'add') return itemForm(id);
    const item = /^items\/([0-7][0-9A-HJKMNP-TV-Z]{25})(?:\/(edit))?$/.exec(sub);
    if (item) return item[2] ? itemForm(id, item[1]) : itemScreen(id, item[1]!);
    if (!sub) return journeyHome(id);
  }
  if (path === '/') return home();
  render('<section class="panel"><h1>Page not found</h1><p><a href="/">Return to your journeys</a></p></section>');
}
perform(route);
