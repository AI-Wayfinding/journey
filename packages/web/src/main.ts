import { EXPIRED_LINK } from './messages.js';
import { prfOutput } from './prf.js';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { newId, signEntry, validAgentName, verifyLog, wrapJourneyKey } from '@ai-wayfinding/core';
import type { CommentBody, ItemBody, ProtocolRecord } from '@ai-wayfinding/core';
import { backupKey, clearPersonKeys, getAccountName, getPersonKeys, lockPersonKeys, newBackupCode, onPersonKeysCleared, parseBackupCode, restorePersonKeys, sealPersonKeys, sealUnlockedKeys, setAccountName, unlockPersonKeys } from './keys.js';
import { passkeyError } from './passkey-errors.js';
import type { PersonKeys, SealedPersonKeys } from './keys.js';
import { ApiError, allRecords, api, appendEntry, createJourney, currentKey, encryptedEntry, exportEncrypted, itemVersions, letIn, listings, removeMember, rotatePending, saveRecord, verifiedJourney } from './journey.js';
import type { JourneyContext, JourneyListing } from './journey.js';
import './style.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
const signOutChannel = new BroadcastChannel('wayfinding-sign-out');
signOutChannel.onmessage = () => { lockPersonKeys(); navigate('/sign-in'); };
// This is only an invitation request token, never a person or journey key. It survives the email-link navigation in this tab.
const INVITE_FRAGMENT = 'wayfinding-invitation';
const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let email = '';
let requestedRoute = location.pathname + location.hash;
let recovery: { identity: string; recipient: string; wrap: string; listing: JourneyListing } | null = null;
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const memberName = (member: { id: string; name?: string; kind: 'person' | 'agent' }): string => member.kind === 'agent' ? member.name ?? `Agent ${member.id.slice(0, 8)}` : member.id;
const input = (form: HTMLFormElement, name: string): string => String(new FormData(form).get(name) ?? '').trim();
const read = (name: string) => (root.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.value ?? '';
// Same markup and styles as the website footer (wayfinding-site src/components/Footer.astro). Keep both in step.
const FOOTER = `<footer class="site-footer"><span>Wayfinding is how you move when the destination is uncertain.</span><nav aria-label="Footer"><a href="https://wayfinding.support/#start">Start your journey</a><a href="https://app.wayfinding.support">Sign in to your journey</a><a href="https://wayfinding.support/agents/start.md">Agent instructions</a><a href="https://wayfinding.support/#facilitator">Work with a facilitator</a><a href="https://github.com/AI-Wayfinding">Source code</a><a href="https://wayfinding.support/privacy/">Privacy policy</a><a href="mailto:hello@wayfinding.support">hello@wayfinding.support</a></nav></footer>`;
function render(content: string): void {
  root.innerHTML = `<header><a class="brand" href="/"><img src="/wayfinding-mark.svg" alt="" />AI Wayfinding Journeys</a><nav><a href="/">My journeys</a>${getPersonKeys() ? '<a href="/new">Start a journey</a><a href="/account">Account</a><button class="secondary" id="logout">Sign out</button>' : '<a href="/sign-in">Sign in</a>'}</nav></header><main id="content">${content}</main>${FOOTER}`;
  root.querySelector('#logout')?.addEventListener('click', () => perform(async () => { await clearPersonKeys(); sessionStorage.removeItem(INVITE_FRAGMENT); email = ''; try { await api('/auth/logout', 'POST', {}); } catch (cause) { if (!(cause instanceof ApiError && cause.status === 401)) throw cause; } signOutChannel.postMessage('signed-out'); navigate('/sign-in'); }));
}
function error(message: string): void { const main = root.querySelector('main') ?? root; const box = document.createElement('p'); box.className = 'error'; box.setAttribute('role', 'alert'); box.textContent = message; main.prepend(box); }
function perform(action: () => Promise<void>): void { void action().catch(cause => {
  if (cause instanceof ApiError && cause.status === 401 && getPersonKeys() && !['/recover', '/sign-in', '/continue', '/auth/verify'].includes(location.pathname)) { lockPersonKeys(); navigate('/continue'); return; }
  error(passkeyError(cause));
}); }
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
const noPrf = "This passkey can't protect your journey keys. Use your device's own passkeys (iCloud Keychain on Apple devices, Google Password Manager on Android or Chrome), or a password manager that supports PRF, such as a recent 1Password or Bitwarden.";
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
type PrfOptions<T> = Omit<T, 'extensions'> & { extensions: { prf: { eval: { first: string } } } };
type PasskeyStage = 'register-create' | 'register-get' | 'login' | 'continue';
// Diagnostics describe only the shape of a passkey response: never the PRF output, keys, credential ids or email.
function prfShape(value: unknown): { prf: string; enabled: string; first: string; length: number } {
  const prf = value as { enabled?: unknown; results?: { first?: unknown } } | undefined;
  const first = prf?.results?.first;
  const kind = first === undefined ? 'absent' : typeof first === 'string' ? 'string' : Object.prototype.toString.call(first) === '[object ArrayBuffer]' ? 'arraybuffer' : ArrayBuffer.isView(first) ? 'view' : Array.isArray(first) ? 'array' : first && typeof first === 'object' ? 'object' : 'other';
  const length = typeof first === 'string' ? first.length : kind === 'arraybuffer' || kind === 'view' ? (first as ArrayBuffer).byteLength : 0;
  return { prf: prf ? 'present' : 'absent', enabled: prf?.enabled === true ? 'true' : prf?.enabled === false ? 'false' : 'absent', first: kind, length };
}
// The AAGUID names the passkey provider model (for example 1Password or iCloud Keychain), not the person.
function aaguid(authenticatorData: string | undefined): string | undefined {
  if (!authenticatorData) return undefined;
  try {
    const bytes = decode(authenticatorData);
    if (bytes.length < 53) return undefined;
    const hex = [...bytes.slice(37, 53)].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch { return undefined; }
}
function errorName(cause: unknown): string {
  const value = cause as { code?: unknown; name?: unknown } | null;
  return String(typeof value?.code === 'string' ? value.code : typeof value?.name === 'string' ? value.name : 'unknown').slice(0, 60);
}
function browserName(): string {
  const ua = navigator.userAgent;
  const match = /(Edg|Firefox|Chrome)\/(\d+)/.exec(ua);
  if (match) return `${match[1]} ${match[2]}`;
  const safari = /Version\/(\d+)\S* .*Safari/.exec(ua);
  return safari ? `Safari ${safari[1]}` : 'other';
}
function reportPasskey(report: { stage: PasskeyStage; outcome: 'ok' | 'no-prf' | 'no-output' | 'error' } & Record<string, unknown>): void {
  void fetch('/v1/diagnostics/passkey', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Wayfinding': '1' }, body: JSON.stringify({ ...report, browser: browserName() }) }).catch(() => undefined);
}
async function authenticatedPrf(): Promise<Uint8Array> {
  const options = await api<PrfOptions<Parameters<typeof startAuthentication>[0]['optionsJSON']>>('/auth/passkey/login/options', 'POST', {});
  let response: Awaited<ReturnType<typeof startAuthentication>>;
  try { response = await startAuthentication({ optionsJSON: { ...options, extensions: { prf: { eval: { first: decode(options.extensions.prf.eval.first) } } } } }); }
  catch (cause) { reportPasskey({ stage: 'login', outcome: 'error', error: errorName(cause) }); throw new Error(passkeyError(cause)); }
  const output = prfOutput(response.clientExtensionResults?.prf?.results?.first);
  reportPasskey({ stage: 'login', outcome: output ? 'ok' : 'no-output', ...prfShape(response.clientExtensionResults?.prf), attachment: response.authenticatorAttachment });
  if (!output) throw new Error(noPrf);
  try {
    const { id, rawId, type, response: details } = response;
    await api('/auth/passkey/login/verify', 'POST', { response: { id, rawId, type, response: { clientDataJSON: details.clientDataJSON, authenticatorData: details.authenticatorData, signature: details.signature, userHandle: details.userHandle }, clientExtensionResults: {} } });
    return output;
  } catch (cause) { output.fill(0); throw cause; }
}
async function passkeyConfirmation(): Promise<void> { (await authenticatedPrf()).fill(0); }
async function openWithPasskey(sealed: SealedPersonKeys): Promise<void> {
  const output = await authenticatedPrf();
  const matching = await api<SealedPersonKeys | null>('/me/keys');
  await unlockPersonKeys(matching ?? sealed, output);
}
async function registrationPrf(credentialId: string, salt: Uint8Array): Promise<Uint8Array> {
  const status = root.querySelector<HTMLElement>('#passkey-status');
  if (status) status.textContent = 'Your passkey needs one more tap to protect your keys. Confirm it again.';
  const credential = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)).buffer, rpId: location.hostname, allowCredentials: [{ type: 'public-key', id: new Uint8Array(decode(credentialId)).buffer }], userVerification: 'required', extensions: { prf: { eval: { first: new Uint8Array(salt).buffer } } } } }).catch(cause => { throw new Error(passkeyError(cause, 'add')); });
  const result = (credential as PublicKeyCredential | null)?.getClientExtensionResults().prf;
  const output = prfOutput(result?.results?.first);
  reportPasskey({ stage: 'register-get', outcome: output ? 'ok' : 'no-output', ...prfShape(result), attachment: (credential as PublicKeyCredential | null)?.authenticatorAttachment ?? undefined });
  if (!output) throw new Error(noPrf);
  return output;
}
function startScreen(): void {
  if (getPersonKeys()) { void home(); return; }
  render(`<section class="panel"><h1>Let's get started</h1><div class="actions"><a class="button" href="/sign-in">Start your journey</a><a class="button" href="/continue">Continue your journey</a><a class="button" href="/join">Join a journey you've been invited to</a></div></section>`);
}
function joinScreen(): void {
  render('<section class="panel"><h1>Join a journey you\'ve been invited to</h1><p>Open the invitation link from your email, or paste it here.</p><form id="join-link"><label for="invite-link">Invitation link</label><input id="invite-link" name="invite-link" type="url" required /><button type="submit">Open invitation</button></form></section>');
  form('join-link', async f => { const url = new URL(input(f, 'invite-link')); if (url.origin !== location.origin || url.pathname !== '/invite' || !/^[A-Za-z0-9_-]{43,}$/.test(url.hash.slice(1))) throw new Error('This is not a Wayfinding invitation link.'); navigate('/invite' + url.hash); });
}
function continueScreen(): void {
  render('<section class="panel"><h1>Continue your journey</h1><p>Use your passkey to sign in and unlock your journeys.</p><div class="actions"><button id="passkey-continue">Continue with passkey</button><a href="/sign-in">Use an email link instead</a><a href="/recover">Lost your passkey? Use a backup code</a></div></section>');
  root.querySelector('#passkey-continue')?.addEventListener('click', () => perform(async () => {
    try {
      const options = await api<PrfOptions<Parameters<typeof startAuthentication>[0]['optionsJSON']>>('/auth/passkey/start', 'POST', {});
      const response = await startAuthentication({ optionsJSON: { ...options, extensions: { prf: { eval: { first: decode(options.extensions.prf.eval.first) } } } } });
      const first = prfOutput(response.clientExtensionResults?.prf?.results?.first);
      try {
        const { id, rawId, type, response: details } = response;
        try { await api('/auth/passkey/finish', 'POST', { response: { id, rawId, type, response: { clientDataJSON: details.clientDataJSON, authenticatorData: details.authenticatorData, signature: details.signature, userHandle: details.userHandle }, clientExtensionResults: {} } }); }
        catch { throw new Error('This passkey is not set up for passkey-only sign-in yet. Sign in once with an email link to update it.'); }
        reportPasskey({ stage: 'continue', outcome: first ? 'ok' : 'no-output', ...prfShape(response.clientExtensionResults?.prf), attachment: response.authenticatorAttachment });
        const sealed = await api<SealedPersonKeys | null>('/me/keys');
        if (!sealed) throw new Error('No encrypted keys were saved for this account.');
        // Some password managers, including 1Password, only return PRF when the passkey is named; ask once more if so.
        if (first) await unlockPersonKeys(sealed, first); else await openWithPasskey(sealed);
        navigate('/');
      } finally { first?.fill(0); }
    } catch (cause) { throw new Error(passkeyError(cause)); }
  }));
}
function signIn(destination = '/'): void {
  requestedRoute = destination === '/sign-in' ? '/' : destination;
  render(`<section class="panel"><p class="eyebrow">YOUR JOURNEY STARTS HERE</p><h1>Sign in</h1><p>Enter your email address. We'll send a private link to confirm it's you.</p><form id="email-form"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required /><div class="actions"><button type="submit">Send sign-in link</button></div></form><p><a href="/recover">Lost your passkey? Use a backup code</a></p></section>`);
  form('email-form', async f => { email = input(f, 'email'); await api('/auth/email/start', 'POST', { email, ...(/^\/agent-sessions\/[A-Za-z0-9_-]+$/.test(requestedRoute) ? { returnPath: requestedRoute } : {}) }); render('<section class="panel"><h1>Check your email</h1><p>Open the Wayfinding link to continue. It expires in 15 minutes. If you are joining a journey, keep this invitation open and return after signing in.</p></section>'); });
  // An already verified session can unlock this browser with PRF without another email link.
  void api<SealedPersonKeys | null>('/me/keys').then(sealed => {
    if (!sealed || getPersonKeys() || !root.querySelector('#email-form')) return;
    render('<section class="panel"><h1>Unlock with your passkey</h1><p>Confirm your passkey once to continue.</p><div class="actions"><button id="unlock">Unlock with passkey</button><a href="/recover">Lost your passkey? Use a backup code</a></div></section>');
    root.querySelector('#unlock')?.addEventListener('click', () => perform(async () => { await openWithPasskey(sealed); navigate(requestedRoute); }));
  }).catch(() => { /* No verified session: use the email form. */ });
}
async function createPasskey(first: boolean): Promise<void> {
  if (!first && !getPersonKeys()) throw new Error('Unlock your keys before adding a passkey.');
  const options = await api<PrfOptions<Parameters<typeof startRegistration>[0]['optionsJSON']>>('/auth/passkey/register/options', 'POST', {});
  const salt = decode(options.extensions.prf.eval.first);
  let stage: PasskeyStage = 'register-create';
  let response: Awaited<ReturnType<typeof startRegistration>>;
  let output: Uint8Array;
  try {
    response = await startRegistration({ optionsJSON: { ...options, extensions: { prf: { eval: { first: salt } } } } });
    const prf = response.clientExtensionResults?.prf;
    const created = prfOutput(prf?.results?.first);
    reportPasskey({ stage, outcome: created ? 'ok' : prf?.enabled === false ? 'no-prf' : 'no-output', ...prfShape(prf), attachment: response.authenticatorAttachment, aaguid: aaguid(response.response.authenticatorData) });
    if (!created && prf?.enabled === false) throw new Error(noPrf);
    stage = 'register-get';
    output = created ?? await registrationPrf(response.rawId, salt);
  } catch (cause) {
    if (!(cause instanceof Error && cause.message === noPrf)) reportPasskey({ stage, outcome: 'error', error: errorName(cause) });
    throw new Error(passkeyError(cause, 'add'));
  }
  const unlockOutput = first ? new Uint8Array(output) : null;
  try {
    const sealed = first ? (await sealPersonKeys(output)).sealed : await sealUnlockedKeys(output);
    const { id, rawId, type, response: details } = response;
    await api('/auth/passkey/register/verify', 'POST', { response: { id, rawId, type, response: { clientDataJSON: details.clientDataJSON, attestationObject: details.attestationObject, transports: details.transports }, clientExtensionResults: { prf: { enabled: true } } }, sealed });
    if (unlockOutput) await unlockPersonKeys(sealed, unlockOutput);
  } finally { output.fill(0); unlockOutput?.fill(0); }
}

async function makeBackupCodes(): Promise<string[]> {
  if (!getPersonKeys()) throw new Error('Unlock your keys first.');
  const codes = Array.from({ length: 8 }, newBackupCode);
  const sealed = await Promise.all(codes.map(async code => {
    const bytes = parseBackupCode(code);
    const verifier = await backupKey(bytes, 'verifier');
    const wrapping = await backupKey(bytes, 'wrapping');
    const verifierHash = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encode(verifier)))));
    verifier.fill(0);
    return { verifierHash, ...await sealUnlockedKeys(wrapping) };
  }));
  await api('/me/backup-codes', 'PUT', { codes: sealed.map(({ verifierHash, identity, signing }) => ({ verifierHash, identity, signing })) });
  return codes;
}
function showBackupCodes(codes: string[], destination: string): void {
  render(`<section class="panel"><h1>Save your backup codes</h1><p>These eight codes work once each. Store them away from your passkeys. A code lets you add a new passkey; it cannot open a journey on its own. We cannot show them again.</p><pre id="backup-copy-value">${escape(codes.join('\n'))}</pre><div class="actions"><button id="backup-copy" class="secondary">Copy</button><button id="backup-download" class="secondary">Download</button></div><p id="copy-status" role="status"></p><label class="checkbox" for="saved-codes"><input type="checkbox" id="saved-codes" /> I saved these codes</label><button id="backup-continue" disabled>Continue</button></section>`);
  copy('backup-copy');
  root.querySelector('#backup-download')?.addEventListener('click', () => download('wayfinding-backup-codes.txt', codes.join('\n') + '\n'));
  root.querySelector('#saved-codes')?.addEventListener('change', event => { (root.querySelector<HTMLButtonElement>('#backup-continue')!).disabled = !(event.target as HTMLInputElement).checked; });
  root.querySelector('#backup-continue')?.addEventListener('click', () => { codes.fill(''); navigate(destination); });
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
    render(`<section class="panel"><h1>Create your passkey</h1><p>One passkey signs you in and protects your journey keys. An encrypted copy stays in this browser so you can return without another passkey tap.</p><p>Works with Chrome or Edge 116+, Safari 18+, or Firefox 139+ with a passkey that supports protecting keys. There is no weaker fallback.</p><div class="actions"><button id="register">Create passkey</button></div><p id="passkey-status" role="status"></p></section>`);
    const register = root.querySelector<HTMLButtonElement>('#register')!;
    if (!supportedPrfBrowser()) { register.disabled = true; error('This browser cannot use this kind of passkey. Use Chrome or Edge 116+, Safari 18+, or Firefox 139+ with a compatible passkey.'); return; }
    register.addEventListener('click', () => perform(async () => {
      register.disabled = true;
      try { await createPasskey(true); showBackupCodes(await makeBackupCodes(), requestedRoute); }
      finally { if (register.isConnected) register.disabled = false; }
    }));
  } else {
    render(`<section class="panel"><h1>Confirm your passkey</h1><p>One passkey tap signs you in and unlocks your journey keys in this browser.</p><div class="actions"><button id="confirm">Sign in with passkey</button><a href="/recover">Lost your passkey? Use a backup code</a></div></section>`);
    root.querySelector('#confirm')?.addEventListener('click', () => perform(async () => {
      const output = await authenticatedPrf();
      try {
        const sealed = await api<SealedPersonKeys | null>('/me/keys');
        if (!sealed) throw new Error('No encrypted keys were saved for this account. Sign up again to continue.');
        await unlockPersonKeys(sealed, output);
        navigate(requestedRoute);
      } finally { output.fill(0); }
    }));
  }
}
async function accountName(keys: PersonKeys, rows: JourneyListing[]): Promise<string> {
  const saved = await getAccountName();
  if (saved !== null) return saved;
  for (const row of rows) {
    const profile = (await verifiedJourney(row.id, row.principal, keys)).state.members[row.principal]?.profile;
    if (profile) return profile.name;
  }
  return '';
}
async function accountScreen(): Promise<void> {
  const keys = await requireKeys(); if (!keys) return;
  const journeys = await listings();
  const currentName = await accountName(keys, journeys);
  const { passkeys, codesRemaining } = await api<{ passkeys: { id: string; name: string; created: number; lastUsed: number | null }[]; codesRemaining: number }>('/me/passkeys');
  render(`<section class="panel"><h1>Account</h1><form id="profile-form"><label for="your-name">Your name</label><input id="your-name" name="your-name" maxlength="60" value="${escape(currentName)}" /><p class="meta">Your name is shared with people in your journeys, not stored on the server in plain text.</p><button type="submit">Save name</button><p id="profile-status" role="status"></p></form><p>To replace a passkey, add a new one first, then remove the old one. Keep at least one passkey active.</p><ul class="list">${passkeys.map(key => `<li>${escape(key.name)} — added ${escape(new Date(key.created).toLocaleDateString())}; last used ${key.lastUsed ? escape(new Date(key.lastUsed).toLocaleDateString()) : 'never'} <button class="secondary remove-passkey" data-id="${escape(key.id)}" ${passkeys.length === 1 ? 'disabled' : ''}>Remove</button></li>`).join('')}</ul><button id="add-passkey">Add a passkey</button><p>${codesRemaining} backup codes remain.</p><button id="new-backup-codes">Make new backup codes</button><p id="passkey-status" role="status"></p></section>`);
  form('profile-form', async f => {
    const name = input(f, 'your-name');
    if (name && !validAgentName(name)) throw new Error('Your name must be trimmed, 1–60 characters and contain no control characters.');
    // Preserve each journey's independent email choice when updating the account name.
    for (const row of journeys) {
      const ctx = await verifiedJourney(row.id, row.principal, keys);
      if (ctx.state.members[row.principal]?.member.scope === 'read') continue;
      const visibleEmail = ctx.state.members[row.principal]?.profile?.email;
      await appendEntry(ctx, 'member.profile', { id: row.principal, name, ...(visibleEmail ? { email: visibleEmail } : {}) });
    }
    await setAccountName(name);
    root.querySelector<HTMLElement>('#profile-status')!.textContent = 'Name saved.';
  });
  root.querySelector('#add-passkey')?.addEventListener('click', () => perform(async () => { await passkeyConfirmation(); await createPasskey(false); await accountScreen(); }));
  root.querySelectorAll<HTMLButtonElement>('.remove-passkey').forEach(button => button.addEventListener('click', () => perform(async () => { await passkeyConfirmation(); await api(`/me/passkeys/${encodeURIComponent(button.dataset.id!)}`, 'DELETE'); await accountScreen(); })));
  root.querySelector('#new-backup-codes')?.addEventListener('click', () => perform(async () => { await passkeyConfirmation(); showBackupCodes(await makeBackupCodes(), '/account'); }));
}
function recoverScreen(): void {
  render('<section class="panel"><h1>Recover with a backup code</h1><p>Use one saved code to replace a lost passkey. You must add a new passkey before opening your journeys. This code can only be used once.</p><form id="recover-form"><label for="backup-code">Backup code</label><input id="backup-code" name="backup-code" autocomplete="off" required /><button type="submit">Use backup code</button></form></section>');
  form('recover-form', async f => {
    const bytes = parseBackupCode(input(f, 'backup-code'));
    const verifier = await backupKey(bytes, 'verifier');
    const wrapping = await backupKey(bytes, 'wrapping');
    try {
      await api('/auth/backup-code/redeem', 'POST', { verifier: encode(verifier) });
      const sealed = await api<SealedPersonKeys | null>('/me/keys');
      if (!sealed) throw new Error('This backup code did not work.');
      await unlockPersonKeys(sealed, wrapping);
      render('<section class="panel"><h1>Add a new passkey</h1><p>Your backup code is used. Add a passkey before continuing.</p><button id="recover-passkey">Create passkey</button><p id="passkey-status" role="status"></p></section>');
      root.querySelector('#recover-passkey')?.addEventListener('click', () => perform(async () => { await createPasskey(false); render('<section class="panel"><h1>Passkey added</h1><p>You can now remove old passkeys from your account.</p><div class="actions"><a href="/account">Manage passkeys</a><a href="/">Open my journeys</a></div></section>'); }));
    } finally { bytes.fill(0); verifier.fill(0); wrapping.fill(0); }
  });
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
  render(`<section class="panel"><p class="eyebrow">A NEW JOURNEY</p><h1>Start a journey</h1><form id="new-form"><label for="name">Journey name</label><input name="name" id="name" required maxlength="200" /><label for="description">Description (optional)</label><textarea name="description" id="description" placeholder="What brings you here?"></textarea><p class="meta">The server keeps the journey name and the email address you signed in with. The description is encrypted inside your journey.</p><div class="actions"><button type="submit">Create journey</button></div></form></section>`);
  form('new-form', async f => {
    const result = await createJourney(input(f, 'name'), input(f, 'description'), keys);
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
    const name = await accountName(ctx.keys, (await listings()).filter(row => row.id !== ctx.id));
    if (name) await appendEntry(ctx, 'member.profile', { id: ctx.principal, name });
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
function agentPromptScreen(id: string): void {
  const prompt = `Connect to my AI Wayfinding journey. Follow the instructions at https://wayfinding.support/agents/install.md\nMy journey ID is ${id}. You can suggest your name when asking to connect; I can change it before approving.`;
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><p class="eyebrow">ADD YOUR AGENT</p><h1>Add your agent</h1><p>Your AI agent can read this journey and, if you allow it, add to it. Copy this prompt into your agent, such as Claude, ChatGPT, Codex or Cursor.</p><pre id="agent-copy-value">${escape(prompt)}</pre><div class="actions"><button id="agent-copy" class="secondary">Copy prompt</button></div><p id="copy-status" role="status"></p><h2>What happens next</h2><ol><li>Your agent installs the <code>wayfinding</code> tool, asking you before each command.</li><li>It shows you a link and a six-digit code.</li><li>Open the link, check the code matches, change the suggested name if you like, choose what it can do and for how long, and confirm with your passkey.</li></ol><p>You can see and remove your agent at any time under <a href="/journeys/${id}/members">People &amp; agents</a>.</p></section>`);
  copy('agent-copy');
}
async function journeyHome(id: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  const records = await allRecords(ctx), items = itemVersions(records).filter(v => !v.deleted && v.item.itemType !== 'recovery');
  const readOnly = ctx.state.members[ctx.principal]?.member.scope === 'read';
  const name = String(ctx.log[0]?.body.name ?? 'Journey');
  render(`<section class="panel"><p class="eyebrow">JOURNEY</p><h1>${escape(name)}</h1>${ctx.log[0]?.body.description ? `<p>${escape(String(ctx.log[0].body.description))}</p>` : ''}<div class="actions">${readOnly ? '<p class="meta">Your access is read-only.</p>' : `<a class="button" href="/journeys/${id}/add">Add an item</a>`}<a class="button" href="/journeys/${id}/agent">Add your agent</a><a class="button" href="/journeys/${id}/members">Share this journey</a><a class="button" href="/journeys/${id}/export">Export</a></div></section><section class="panel"><h2>Items</h2><div class="grid"><div><label for="filter">Filter by type</label><select id="filter"><option value="">All types</option>${[...new Set(items.map(v => v.item.itemType))].map(t => `<option value="${escape(t)}">${escape(t)}</option>`).join('')}</select></div><div><label for="search">Search your items</label><input id="search" type="search" placeholder="Search titles and text" /></div></div><div id="items" class="cards"></div></section>`);
  const showItems = () => { const filter = read('filter'), query = read('search').toLocaleLowerCase(); root.querySelector('#items')!.innerHTML = items.filter(({ item }) => (!filter || item.itemType === filter) && (!query || `${item.title} ${item.body}`.toLocaleLowerCase().includes(query))).map(({ item, root: itemRoot }) => `<article class="card"><p class="meta">${escape(item.itemType)}</p><h3><a href="/journeys/${id}/items/${escape(itemRoot)}">${escape(item.title)}</a></h3><p>${escape(item.body.slice(0, 160))}</p></article>`).join('') || '<p>No matching items.</p>'; };
  root.querySelector('#search')?.addEventListener('input', showItems); root.querySelector('#filter')?.addEventListener('change', showItems); showItems();
}
async function itemScreen(id: string, itemId: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  const view = itemVersions(await allRecords(ctx)).find(entry => entry.item.id === itemId || entry.versions.some(v => v.id === itemId));
  if (!view || view.deleted) throw new Error('Item not found.');
  const { item, versions, comments } = view;
  const readOnly = ctx.state.members[ctx.principal]?.member.scope === 'read';
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><p class="eyebrow">${escape(item.itemType)}</p><h1>${escape(item.title)}</h1><p class="meta">Tags: ${escape(item.tags.join(', ') || 'none')}</p><pre>${escape(item.body)}</pre>${readOnly ? '' : `<div class="actions"><a href="/journeys/${id}/items/${escape(itemId)}/edit" class="button">Edit item</a><button class="secondary" id="delete-item">Delete item</button></div>`}</section><section class="panel"><h2>Versions</h2><ul class="list">${versions.map(v => `<li><p class="meta">${escape(v.created)} · ${escape(ctx.state.members[v.author]?.member.kind === 'agent' ? memberName(ctx.state.members[v.author]!.member) : v.authoredBy)}</p><pre>${escape(v.body)}</pre></li>`).join('')}</ul></section><section class="panel"><h2>Comments</h2><ul class="list">${comments.map(c => `<li><p class="meta">${escape(c.body.at)} · ${escape(ctx.state.members[String(c.body.author)]?.member.kind === 'agent' ? memberName(ctx.state.members[String(c.body.author)]!.member) : c.body.author)}</p><p>${escape(c.body.body)}</p></li>`).join('')}</ul>${readOnly ? '<p>Your access is read-only.</p>' : `<form id="comment-form"><label for="comment">Add a comment</label><textarea id="comment" name="comment" required></textarea><div class="actions"><button type="submit">Add comment</button></div></form>`}</section>`);
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
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><h1>People in this journey</h1><p>Only journey members can see who is here. People who manage members are marked below.</p><label class="checkbox" for="show-my-email"><input type="checkbox" id="show-my-email" ${ctx.state.members[ctx.principal]?.profile?.email ? 'checked' : ''} ${ctx.state.members[ctx.principal]?.member.scope === 'read' ? 'disabled' : ''} /> Show my email to people in this journey</label>${pendingRotation ? '<p class="notice">Key update pending. A person who manages members can finish it on their next visit.</p>' : ''}<ul class="list">${Object.entries(ctx.state.members).map(([memberId, { member, grants, profile }]) => `<li><strong>${member.kind === 'agent' ? escape(memberName(member)) : escape(profile?.name || (member.support ? 'Wayfinding support (Hypha)' : 'Person'))}${memberId === ctx.principal ? ' (you)' : ''}</strong>${member.kind === 'person' && profile?.email ? `<p>${escape(profile.email)}</p>` : ''}<p class="meta">${escape(memberId)} · ${grants.includes('members.manage') ? 'Manages people' : 'Member'}${member.kind === 'agent' || member.support ? ` · ${escape(member.scope ?? 'readwrite')} · ${escape(member.expiresAt ?? 'session')}` : ''}</p>${member.kind === 'agent' && (holder || member.addedBy === ctx.principal) || holder && memberId !== ctx.principal ? '<div class="actions">' : ''}${member.kind === 'agent' && (holder || member.addedBy === ctx.principal) ? `<button class="secondary" data-rename="${escape(memberId)}">Rename</button>` : ''}${holder && memberId !== ctx.principal ? `<button class="secondary" data-remove="${escape(memberId)}">Remove</button>${member.kind === 'person' && !member.support ? `<button class="secondary" data-grant="${escape(memberId)}">${grants.includes('members.manage') ? 'Stop managing people' : 'Let manage people'}</button>` : ''}` : ''}${member.kind === 'agent' && (holder || member.addedBy === ctx.principal) || holder && memberId !== ctx.principal ? '</div>' : ''}</li>`).join('')}</ul><div class="actions"><button id="leave" class="secondary">Leave journey</button></div></section>${holder ? `<section class="panel"><h2>Share this journey with other wayfinders</h2><form id="invite-form"><label for="invite-email">Email addresses (separate with commas)</label><input id="invite-email" name="invite-email" type="text" placeholder="friend@example.org" /><label for="invite-scope">Invitation</label><select id="invite-scope" name="invite-scope"><option value="person">Invite a person</option><option value="support">Invite Wayfinding support</option></select><p class="meta">Support joins like any other person. Their access ends after seven days.</p><div class="actions"><button type="submit" id="invite-send">Send invitation</button><button type="button" id="invite-link-only" class="secondary">Copy link instead</button></div></form><div id="invitation"></div></section><section class="panel"><h2>Waiting to join</h2><ul class="list">${pending.length ? pending.map(row => `<li><code>${escape(row.principal)}</code>${row.support ? ' · Wayfinding support (Hypha), read only' : ''} <button data-let-in="${escape(row.principal)}">Let in</button></li>`).join('') : '<li>No one is waiting.</li>'}</ul></section>` : ''}`);
  const fresh = async () => { const latest = await context(id); if (!latest) throw new Error('Sign in again.'); return latest; };
  root.querySelector<HTMLInputElement>('#show-my-email')?.addEventListener('change', event => perform(async () => {
    const toggle = event.target as HTMLInputElement;
    const show = toggle.checked;
    toggle.disabled = true;
    try {
      const latest = await fresh();
      const name = latest.state.members[latest.principal]?.profile?.name ?? await getAccountName() ?? '';
      const { email: address } = show ? await api<{ email: string }>('/me/email') : { email: undefined };
      await appendEntry(latest, 'member.profile', { id: latest.principal, name, ...(address ? { email: address } : {}) });
      await membersScreen(id);
    } catch (cause) { toggle.checked = !show; toggle.disabled = false; throw cause; }
  }));
  const invite = async (addresses: string[]) => {
    await fresh();
    if (addresses.length > 5 || addresses.some(address => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) throw new Error('Enter up to five valid email addresses.');
    for (const email of addresses.length ? addresses : ['']) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
      const inviteIdHash = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await api(`/journeys/${id}/invites`, 'POST', { inviteIdHash, expiresAt: Date.now() + 7 * 86_400_000, support: read('invite-scope') === 'support', ...(email ? { email, inviteId: secret } : {}) }, ctx.principal);
      const value = `${location.origin}/invite#${secret}`;
      root.querySelector('#invitation')!.innerHTML = `<p class="notice">${email ? `Invitation sent to ${escape(email)}. ` : ''}A member must let them in.</p><pre id="invite-copy-value">${escape(value)}</pre><button id="invite-copy">Copy link</button><p id="copy-status" role="status"></p>`;
    }
    copy('invite-copy');
  };
  form('invite-form', async f => { const addresses = input(f, 'invite-email').split(/[\s,;]+/).filter(Boolean); if (!addresses.length) throw new Error('Enter an email address or choose Copy link instead.'); await invite(addresses); });
  root.querySelector('#invite-link-only')?.addEventListener('click', () => perform(async () => { await invite([]); }));
  root.querySelectorAll<HTMLButtonElement>('[data-let-in]').forEach(button => button.addEventListener('click', () => perform(async () => { const latest = await fresh(); const person = pending.find(row => row.principal === button.dataset.letIn); if (!person) throw new Error('This person is no longer waiting.'); await letIn(latest, person); await membersScreen(id); })));
  root.querySelectorAll<HTMLButtonElement>('[data-grant]').forEach(button => button.addEventListener('click', () => perform(async () => { const latest = await fresh(); const target = button.dataset.grant!; const grants = latest.state.grants[target] ?? []; await appendEntry(latest, grants.includes('members.manage') ? 'grant.remove' : 'grant.add', { member: target, grant: 'members.manage' }); await membersScreen(id); })));
  root.querySelectorAll<HTMLButtonElement>('[data-rename]').forEach(button => button.addEventListener('click', () => perform(async () => {
    const target = button.dataset.rename!;
    const latest = await fresh();
    const member = latest.state.members[target]?.member;
    if (!member || member.kind !== 'agent') throw new Error('This agent is no longer here.');
    const name = prompt('Name for this agent', member.name ?? 'Agent');
    if (name === null) return;
    if (!validAgentName(name)) throw new Error('Agent name must be trimmed, 1–60 characters and contain no control characters.');
    await appendEntry(latest, 'member.rename', { id: target, name });
    await membersScreen(id);
  })));
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
      try { const row = (await listings()).find(j => j.id === result.journeyId && j.principal === principal); if (row) {
        const ctx = await verifiedJourney(row.id, principal, keys);
        const name = await accountName(keys, (await listings()).filter(existing => existing.id !== row.id));
        if (name && ctx.state.members[principal]?.member.scope !== 'read') await appendEntry(ctx, 'member.profile', { id: principal, name });
        navigate('/journeys/' + row.id); return;
      } }
      catch { /* The member has not yet posted the complete signed log and wrap. */ }
      if (document.querySelector('#wait-status')) setTimeout(() => void refresh(), 4000);
    };
    void refresh();
  }));
  // The list is fetched only to check authentication; the invite fragment stays in memory.
  void lists;
}

async function agentScreen(sessionId: string): Promise<void> {
  const agent = await api<{ status: string; journeyId: string; principal: string; recipient: string; signingKey: string; requestedScope: 'read' | 'readwrite'; remembered: boolean; name: string | null }>(`/agent-sessions/${sessionId}`);
  const keys = getPersonKeys(); if (!keys) { signIn(`/agent-sessions/${sessionId}`); return; }
  if (agent.status !== 'pending') { render(`<section class="panel"><h1>Agent request ${escape(agent.status)}</h1></section>`); return; }
  const ctx = await context(agent.journeyId); if (!ctx) return;
  const hours = agent.remembered ? '<option value="8">8 hours</option><option value="168">7 days</option><option value="2160">90 days</option>' : '<option value="1">1 hour</option><option value="8">8 hours</option>';
  render(`<section class="panel"><h1>Approve an agent</h1><p>Check the six-digit code shown by the agent before granting access. Choose what it can do and for how long.</p><form id="agent-form"><label for="agent-code">Six-digit code</label><input id="agent-code" name="agent-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required /><label for="agent-name">Name</label><input id="agent-name" name="agent-name" maxlength="60" value="${escape(agent.name ?? 'Agent')}" required /><label for="agent-scope">Access</label><select id="agent-scope" name="agent-scope"><option value="read">Read only</option><option value="readwrite">Read and write</option></select><label for="agent-hours">How long?</label><select id="agent-hours" name="agent-hours">${hours}</select><div class="actions"><button type="submit">Confirm with passkey</button></div></form></section>`);
  form('agent-form', async f => {
    const name = String(new FormData(f).get('agent-name') ?? '');
    if (!validAgentName(name)) throw new Error('Agent name must be trimmed, 1–60 characters and contain no control characters.');
    await passkeyConfirmation();
    const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys);
    const scope = input(f, 'agent-scope') as 'read' | 'readwrite', expiresAt = Date.now() + Number(input(f, 'agent-hours')) * 3_600_000;
    const member = { id: agent.principal, kind: 'agent' as const, recipient: agent.recipient, signingKey: agent.signingKey, addedBy: ctx.principal, name, scope, expiresAt: new Date(expiresAt).toISOString() };
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
window.addEventListener('pagehide', lockPersonKeys);
async function route(): Promise<void> {
  const path = location.pathname;
  if (path === '/auth/verify') return verifyEmail();
  if (path === '/sign-in') return signIn();
  if (path === '/continue') return continueScreen();
  if (path === '/recover') return recoverScreen();
  if (path === '/account') return accountScreen();
  if (path === '/join') return joinScreen();
  if (path === '/invite') return acceptInvite();
  const agent = /^\/agent-sessions\/([A-Za-z0-9_-]+)$/.exec(path); if (agent) return agentScreen(agent[1]!);
  if (path === '/new') { const keys = await requireKeys(); if (keys) newJourney(keys); return; }
  const journey = /^\/journeys\/([0-7][0-9A-HJKMNP-TV-Z]{25})(?:\/(.*))?$/.exec(path);
  if (journey) {
    const id = journey[1]!, sub = journey[2] ?? '';
    if (sub === 'recovery') return recoveryScreen();
    if (sub === 'members') return membersScreen(id);
    if (sub === 'agent') return agentPromptScreen(id);
    if (sub === 'export') return exportScreen(id);
    if (sub === 'add') return itemForm(id);
    const item = /^items\/([0-7][0-9A-HJKMNP-TV-Z]{25})(?:\/(edit))?$/.exec(sub);
    if (item) return item[2] ? itemForm(id, item[1]) : itemScreen(id, item[1]!);
    if (!sub) return journeyHome(id);
  }
  if (path === '/') return getPersonKeys() ? home() : startScreen();
  render('<section class="panel"><h1>Page not found</h1><p><a href="/">Return to your journeys</a></p></section>');
}
perform(async () => {
  await restorePersonKeys();
  if (getPersonKeys()) {
    try { await api('/me/keys'); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { lockPersonKeys(); navigate('/continue'); return; }
      throw cause;
    }
  }
  await route();
});
