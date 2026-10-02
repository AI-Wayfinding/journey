import { EXPIRED_LINK, UPDATE_REQUIRED } from './messages.js';
import { prfOutput } from './prf.js';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { canControl, canRenameAgent, canWriteContent, isPersonGuide, ownsAgent, replayControl, effectiveScope, createAgeIdentity, createSigningIdentity, linkLookupHash, newId, newLinkSecret, sealLinkIdentity, validAgentName, wrapJourneyKey } from '@ai-wayfinding/core';
import type { ArtifactAttachment, ArtifactContent, ArtifactPayload, ArtifactType, Member, ProtocolRecord } from '@ai-wayfinding/core';
import { backupKey, clearPersonKeys, getAccountName, getPersonKeys, lockPersonKeys, newBackupCode, onPersonKeysCleared, parseBackupCode, restorePersonKeys, sealPersonKeys, sealUnlockedKeys, setAccountName, unlockPersonKeys } from './keys.js';
import { passkeyError } from './passkey-errors.js';
import type { PersonKeys, SealedPersonKeys } from './keys.js';
import { ApiError, allRecords, api, appendEntry, createJourney, currentKey, makeControl, exportEncrypted, itemVersions, letIn, listings, removeMember, rotatePending, saveRecord, verifiedJourney } from './journey.js';
import type { JourneyContext, JourneyListing } from './journey.js';
import { ARTIFACT_TYPES, MAX_ARTIFACT_ATTACHMENTS, MAX_BLOB_BYTES, suggestedArtifact, validPackagePath } from '@ai-wayfinding/core';
import { artifactViews, artifactText, attachmentBytes, commentArtifact, deleteArtifact, downloadAttachment, saveArtifact, uploadAttachment } from './artifacts.js';
import { mountArtifactViewer } from './artifact-viewer.js';
import { PROJECT_STATES, canEditProject, effectiveProjectParticipants, projectSelector, selectProjectArtifacts } from '@ai-wayfinding/core';
import type { ProjectState } from '@ai-wayfinding/core';
import { canCreateProject, canParticipate, createProject, participateProject, placeArtifact, purposeProject, stateProject } from './projects.js';
import { closePrivateVaults, openJourneyVault } from './private-store.js';
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
let disposeViewer: (() => void) | undefined;
function render(content: string): void {
  disposeViewer?.(); disposeViewer = undefined;
  root.innerHTML = `<header><a class="brand" href="/"><img src="/wayfinding-mark.svg" alt="" />AI Wayfinding Journeys</a><nav><a href="/">My journeys</a>${getPersonKeys() ? '<a href="/new">Start a journey</a><a href="/account">Account</a><button class="secondary" id="logout">Sign out</button>' : '<a href="/sign-in">Sign in</a>'}</nav></header><main id="content">${content}</main>${FOOTER}`;
  root.querySelector('#logout')?.addEventListener('click', () => perform(async () => { await clearPersonKeys(); sessionStorage.removeItem(INVITE_FRAGMENT); email = ''; try { await api('/auth/logout', 'POST', {}); } catch (cause) { if (!(cause instanceof ApiError && cause.status === 401)) throw cause; } signOutChannel.postMessage('signed-out'); navigate('/sign-in'); }));
}
function error(message: string): void { const main = root.querySelector('main') ?? root; const box = document.createElement('p'); box.className = 'error'; box.setAttribute('role', 'alert'); box.textContent = message; main.prepend(box); }
function perform(action: () => Promise<void>): void { void action().catch(cause => {
  if (cause instanceof ApiError && cause.status === 401 && getPersonKeys() && !['/recover', '/sign-in', '/continue', '/auth/verify'].includes(location.pathname)) { lockPersonKeys(); navigate('/continue'); return; }
  if (cause instanceof Error && cause.message === UPDATE_REQUIRED) { render('<section class="panel"><h1>Update Wayfinding</h1></section>'); }
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
      if (!canControl(ctx.state, row.principal, 'Profile', row.principal)) continue;
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
  for (const row of rows) { const ctx = await verifiedJourney(row.id, row.principal, keys); checked.push({ id: row.id, principal: row.principal, name: ctx.state.settings!.name }); }
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
  // Listings omit incompatible clients. A remembered principal lets the authenticated
  // protocol endpoint distinguish an update from removal; it never grants access.
  const principal = listing?.principal ?? sessionStorage.getItem(`wayfinding-principal:${keys.signingKey}:${id}`);
  if (!principal) { render('<section class="panel"><h1>Journey unavailable</h1><p>You no longer have access to this journey.</p></section>'); return null; }
  let ctx: JourneyContext;
  try { ctx = await verifiedJourney(id, principal, keys); }
  catch (cause) {
    if (!(cause instanceof ApiError && [403, 404].includes(cause.status))) throw cause;
    render('<section class="panel"><h1>Journey unavailable</h1><p>You no longer have access to this journey.</p></section>'); return null;
  }
  if (ctx.state.pendingRotation && isPersonGuide(ctx.state, ctx.principal)) {
    try { await rotatePending(ctx); return verifiedJourney(id, principal, keys); }
    catch { render('<section class="panel"><h1>Key update pending</h1><p>A person who manages people can complete it on the next visit.</p></section>'); return null; }
  }
  await openJourneyVault(ctx);
  return ctx;
}
function agentPromptScreen(id: string): void {
  const prompt = `Connect to my AI Wayfinding journey. Follow the instructions at https://wayfinding.support/agents/install.md\nMy journey ID is ${id}. You can suggest your name when asking to connect; I can change it before approving.`;
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><p class="eyebrow">ADD YOUR AGENT</p><h1>Add your agent</h1><p>Your AI agent can read this journey and, if you allow it, add to it. Copy this prompt into your agent, such as Claude, ChatGPT, Codex or Cursor.</p><pre id="agent-copy-value">${escape(prompt)}</pre><div class="actions"><button id="agent-copy" class="secondary">Copy prompt</button></div><p id="copy-status" role="status"></p><h2>What happens next</h2><ol><li>Your agent installs the <code>wayfinding</code> tool, asking you before each command.</li><li>It shows you a link and a six-digit code.</li><li>Open the link, check the code matches, change the suggested name if you like, choose what it can do and for how long, and confirm with your passkey.</li></ol><p>You can see and remove your agent at any time under <a href="/journeys/${id}/members">People &amp; agents</a>.</p></section>`);
  copy('agent-copy');
}
async function journeyHome(id: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  const artifacts = await artifactViews(ctx), readOnly = !canWriteContent(ctx.state, ctx.principal);
  render(`<section class="panel"><p class="eyebrow">JOURNEY</p><h1>${escape(ctx.state.settings?.name ?? 'Journey')}</h1>${ctx.state.settings?.description ? `<p>${escape(ctx.state.settings.description)}</p>` : ''}<div class="actions">${readOnly ? '<p class="meta">Your access is read-only or a key update is pending.</p>' : `<a class="button" href="/journeys/${id}/add">Add an artifact</a>`}<a class="button" href="/journeys/${id}/agent">Add your agent</a><a class="button" href="/journeys/${id}/members">Share this journey</a><a class="button" href="/journeys/${id}/export">Export</a><a class="button" href="/journeys/${id}/projects">Projects</a></div></section><section class="panel"><h2>Artifacts</h2><label for="project-filter">Artifact list</label><select id="project-filter"><option value="main">Main (unassigned)</option><option value="all">All artifacts</option>${projectOptions(ctx)}</select><p id="artifact-count" class="meta"></p><div class="grid"><div><label for="filter">Filter by type</label><select id="filter"><option value="">All types</option>${ARTIFACT_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}</select></div><div><label for="search">Search your artifacts</label><input id="search" type="search" placeholder="Search titles, tags and text" /></div></div><div id="artifacts" class="cards"></div></section>`);
  const selector = root.querySelector<HTMLSelectElement>('#project-filter')!;
  selector.value = projectSelector(sessionStorage.getItem(`wayfinding-project-filter:${id}`) ?? undefined);
  // Fail closed for a stored unknown project; never fall back to all artifacts.
  selectProjectArtifacts(ctx.state, selector.value);
  const show = () => {
    const selected = selectProjectArtifacts(ctx.state, selector.value);
    sessionStorage.setItem(`wayfinding-project-filter:${id}`, selector.value);
    const filter = root.querySelector<HTMLSelectElement>('#filter')!.value, query = root.querySelector<HTMLInputElement>('#search')!.value.toLocaleLowerCase();
    const matching = artifacts.filter(view => {
      if (!selected.includes(view.state.id)) return false;
      const p = view.versions.at(-1)!.payload;
      return (!filter || p.content.kind === filter) && (!query || `${p.title} ${p.tags.join(' ')} ${artifactText(p)} ${p.attachments.map(a => a.name).join(' ')}`.toLocaleLowerCase().includes(query));
    });
    root.querySelector('#artifact-count')!.textContent = `${matching.length} matching artifacts in this list`;
    root.querySelector('#artifacts')!.innerHTML = matching.map(view => { const p = view.versions.at(-1)!.payload; return `<article class="card"><p class="meta">${escape(p.content.kind)} · ${escape(p.tags.join(', '))}</p><h3><a href="/journeys/${id}/artifacts/${view.state.id}">${escape(p.title)}</a></h3><p>${escape(artifactText(p).slice(0, 160))}</p></article>`; }).join('') || '<p>No matching artifacts.</p>';
  };
  selector.addEventListener('change', show);
  root.querySelector('#search')?.addEventListener('input', show); root.querySelector('#filter')?.addEventListener('change', show); show();
}
function stateLabel(state: string): string { return state.replace(/-/g, ' '); }
function projectOptions(ctx: JourneyContext, selected?: string): string {
  return Object.values(ctx.state.projects?.items ?? {}).map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${escape(p.purpose.slice(0, 100))} · ${escape(stateLabel(p.state))}</option>`).join('');
}
async function projectsScreen(id: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  const projects = Object.values(ctx.state.projects?.items ?? {});
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><h1>Projects</h1><p>Projects group work, not access. Creating a project does not join it. Agents follow the person who added them.</p><ul id="projects" class="list">${projects.map(p => `<li><a href="/journeys/${id}/projects/${p.id}">${escape(p.purpose.slice(0, 100))}</a><p class="meta">${escape(stateLabel(p.state))} · ${effectiveProjectParticipants(ctx.state, p.id).length} participants · ${selectProjectArtifacts(ctx.state, p.id).length} project artifacts</p></li>`).join('') || '<li>No projects yet.</li>'}</ul></section>${canCreateProject(ctx) ? '<section class="panel"><h2>Create a project</h2><form id="project-create"><label for="project-purpose">Purpose</label><textarea id="project-purpose" name="project-purpose" required></textarea><p>Plain text, up to 10,000 UTF-8 bytes. Starts getting started, with no participants.</p><button type="submit">Create project</button></form></section>' : '<p>Read-only access or a key update prevents project creation.</p>'}`);
  form('project-create', async f => { const project = await createProject(ctx, input(f, 'project-purpose')); navigate(`/journeys/${id}/projects/${project}`); });
}
async function projectScreen(id: string, projectId: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  const project = ctx.state.projects?.items[projectId];
  if (!project) throw new Error('Project not found.');
  const participants = effectiveProjectParticipants(ctx.state, projectId);
  const canEdit = canEditProject(ctx.state, ctx.principal, projectId);
  const selected = selectProjectArtifacts(ctx.state, projectId);
  const artifacts = (await artifactViews(ctx)).filter(v => selected.includes(v.state.id));
  const purposeAt = (seq: number) => { const text = ctx.log.find(e => e.seq === seq)?.body.purpose; return typeof text === 'string' ? `<p class="project-purpose">${escape(text)}</p>` : ''; };
  render(`<section class="panel"><p><a href="/journeys/${id}/projects">← Back to projects</a></p><h1>Project</h1><p id="project-purpose-text" class="project-purpose">${escape(project.purpose)}</p><p id="project-state" class="meta">${escape(stateLabel(project.state))} · Revision ${project.revision}</p><p>Created ${escape(project.at)} by ${escape(attribution(ctx, project.creator))}. Creation does not imply participation.</p><div class="actions">${canParticipate(ctx, 'project.join', projectId) ? '<button id="project-join">Join project</button>' : ''}${canParticipate(ctx, 'project.leave', projectId) ? '<button id="project-leave" class="secondary">Leave project</button>' : ''}</div>${canEdit ? `<form id="project-purpose-form"><label for="project-purpose">Purpose</label><textarea id="project-purpose" name="project-purpose" required>${escape(project.purpose)}</textarea><button type="submit">Save purpose</button></form><form id="project-state-form"><label for="project-state-choice">${project.state === 'archived' ? 'Reopen or change state' : 'Project state'}</label><select id="project-state-choice" name="project-state-choice">${PROJECT_STATES.map(s => `<option value="${s}" ${s === project.state ? 'selected' : ''}>${escape(stateLabel(s))}</option>`).join('')}</select><button type="submit">Save state</button></form>` : '<p>Join this project to edit its purpose and state. Reading its artifacts does not require participation.</p>'}</section><section class="panel"><h2>Participants</h2><p>Agents inherit their adding person’s participation; they do not join separately.</p><ul id="project-participants" class="list">${participants.map(actor => `<li>${escape(attribution(ctx, actor))}${ctx.state.members[actor]?.member.kind === 'agent' ? ' · inherited participation' : ''}</li>`).join('') || '<li>No participants.</li>'}</ul></section><section class="panel"><h2>Project artifacts</h2><p class="meta">${artifacts.length} project artifacts. Everyone in this journey can read, download and export them, including when archived.</p><ul id="project-artifacts" class="list">${artifacts.map(v => `<li><a href="/journeys/${id}/artifacts/${v.state.id}">${escape(v.versions.at(-1)!.payload.title)}</a></li>`).join('') || '<li>No artifacts in this project.</li>'}</ul></section><section class="panel"><h2>Project history</h2><ul id="project-history" class="list">${project.history.map(c => `<li>${escape(c.at)} · ${escape(attribution(ctx, c.actor))} · ${escape(c.type)}${c.from && c.to ? ` · ${escape(stateLabel(c.from))} → ${escape(stateLabel(c.to))}` : ''} · Revision ${c.seq}${purposeAt(c.seq)}</li>`).join('')}</ul></section>`);
  for (const type of ['join', 'leave'] as const) root.querySelector(`#project-${type}`)?.addEventListener('click', () => perform(async () => { await participateProject(ctx, `project.${type}`, projectId); await projectScreen(id, projectId); }));
  form('project-purpose-form', async f => { await purposeProject(ctx, project, input(f, 'project-purpose')); await projectScreen(id, projectId); });
  form('project-state-form', async f => { await stateProject(ctx, project, input(f, 'project-state-choice') as ProjectState); await projectScreen(id, projectId); });
}
function attribution(ctx: JourneyContext, actor: string): string {
  const member = ctx.state.members[actor]?.member ?? ctx.log.flatMap(e => [e.body.creator, e.body.member]).find(m => m && typeof m === 'object' && !Array.isArray(m) && m.id === actor) as Member | undefined;
  return `${member?.kind === 'agent' ? memberName(member) : ctx.state.members[actor]?.profile?.name || 'Person'} · ${actor}`;
}
async function artifactScreen(id: string, artifactId: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  const view = (await artifactViews(ctx)).find(v => v.state.id === artifactId);
  if (!view) throw new Error('Artifact not found. It may have been deleted.');
  const payload = view.versions.at(-1)!.payload, readOnly = !canWriteContent(ctx.state, ctx.principal);
  const placement = ctx.state.projects?.placements[artifactId];
  const project = placement?.project ? ctx.state.projects?.items[placement.project] : undefined;
  const placementPanel = `<section class="panel"><h2>Project placement</h2><p id="placement-current">${project ? `<a href="/journeys/${id}/projects/${project.id}">${escape(project.purpose.slice(0, 100))}</a> · ${escape(stateLabel(project.state))}` : 'Main (unassigned)'}</p><p>Projects group artifacts; everyone in this journey can still read them.</p>${readOnly ? '<p>Read-only access or a key update prevents placement changes.</p>' : `<form id="placement-form"><label for="placement-project">Place saved artifact in</label><select id="placement-project" name="placement-project"><option value="">Main (unassigned)</option>${projectOptions(ctx, placement?.project ?? undefined)}</select><button type="submit">Save placement</button></form>`}<h3>Placement history</h3><ul id="placement-history" class="list">${placement?.history.map(c => `<li>${escape(c.at)} · ${escape(attribution(ctx, c.actor))} · ${escape(c.from ?? 'main')} → ${escape(c.to ?? 'main')} · Revision ${c.seq}</li>`).join('') || '<li>No placement changes.</li>'}</ul></section>`;
  const downloads: ArtifactAttachment[] = [];
  const attachments = (p: ArtifactPayload) => `<ul class="list">${p.attachments.map(a => { const n = downloads.push(a) - 1; return `<li>${escape(a.path ?? a.name)} · ${a.blob.size} bytes <button class="secondary" data-download="${n}">Download ${escape(a.name)}</button></li>`; }).join('')}</ul>`;
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><p class="eyebrow">${escape(payload.content.kind)}</p><h1>${escape(payload.title)}</h1><p class="meta" id="artifact-author">Author: ${escape(attribution(ctx, view.state.author))}</p><p class="meta">Tags: ${escape(payload.tags.join(', ') || 'none')}</p><div id="artifact-viewer"></div>${attachments(payload)}${readOnly ? '' : `<div class="actions"><a href="/journeys/${id}/artifacts/${artifactId}/edit" class="button">Edit artifact</a><button class="secondary" id="delete-artifact">Delete artifact</button></div>`}</section><section class="panel"><h2>Versions</h2><ul class="list" id="versions">${view.versions.map(v => `<li><p class="meta">${escape(v.id)} · ${escape(v.at)} · Writer: ${escape(attribution(ctx, v.actor))}</p><h3>${escape(v.payload.title)}</h3><p>Tags: ${escape(v.payload.tags.join(', '))}</p><pre>${escape(artifactText(v.payload))}</pre>${attachments(v.payload)}</li>`).join('')}</ul></section><section class="panel"><h2>Comments</h2><p>Comments belong to the whole artifact; a version is recorded for context.</p><ul class="list" id="comments">${view.comments.map(c => `<li><p class="meta">${escape(c.at)} · Writer: ${escape(attribution(ctx, c.actor))} · Version: ${escape(c.onVersion ?? 'none')}</p><p>${escape(c.text)}</p></li>`).join('')}</ul>${readOnly ? '<p>Your access is read-only or a key update is pending.</p>' : '<form id="comment-form"><label for="comment">Add a comment</label><textarea id="comment" name="comment" required></textarea><button type="submit">Add comment</button></form>'}</section>`);
  root.querySelector('main')!.insertAdjacentHTML('beforeend', placementPanel);
  form('placement-form', async f => { await placeArtifact(ctx, view.state, input(f, 'placement-project') || null); await artifactScreen(id, artifactId); });
  disposeViewer = mountArtifactViewer(root.querySelector<HTMLElement>('#artifact-viewer')!, payload, (attachment, signal) => attachmentBytes(ctx, attachment, signal));
  root.querySelectorAll<HTMLButtonElement>('[data-download]').forEach(button => button.addEventListener('click', () => perform(async () => { const a = downloads[Number(button.dataset.download)]!; downloadAttachment(a.name, await attachmentBytes(ctx, a)); })));
  form('comment-form', async f => { await commentArtifact(ctx, view, input(f, 'comment')); await artifactScreen(id, artifactId); });
  root.querySelector('#delete-artifact')?.addEventListener('click', () => perform(async () => {
    if (!confirm('Delete this artifact and all its comments? Signed proofs and encrypted metadata remain as retained history, not secure erasure. Its files will no longer be available. Previously downloaded copies cannot be recalled.')) return;
    await deleteArtifact(ctx, view); navigate(`/journeys/${id}`);
  }));
}
async function artifactForm(id: string, artifactId?: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  if (!canWriteContent(ctx.state, ctx.principal)) throw new Error('This journey is read-only for you, or a key update is pending.');
  const previous = artifactId ? (await artifactViews(ctx)).find(v => v.state.id === artifactId) : undefined;
  if (artifactId && !previous) throw new Error('Artifact not found.');
  const p = previous?.versions.at(-1)!.payload;
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><h1>${previous ? 'Edit artifact' : 'Add an artifact'}</h1><form id="artifact-form"><label for="artifact-type">Type</label><select id="artifact-type" name="artifact-type" ${previous ? 'disabled' : ''}>${ARTIFACT_TYPES.map(t => `<option value="${t}" ${p?.content.kind === t || !p && t === 'document' ? 'selected' : ''}>${t}</option>`).join('')}</select><p>Type and original author cannot change. Each save records you as its version writer.</p><label for="artifact-title">Title</label><input id="artifact-title" name="artifact-title" value="${escape(p?.title ?? '')}" required /><div id="type-fields"></div><label for="tags">Tags (comma-separated)</label><input id="tags" name="tags" value="${escape(p?.tags.join(', ') ?? '')}" /><div class="actions" id="suggested-tags">${['note','decision','question','learning','tension','practice','success','resource','position','interview','lesson'].map(t => `<button type="button" class="secondary" data-tag="${t}">${t}</button>`).join('')}</div><p class="meta">Suggested tags are optional, not artifact types.</p>${p?.attachments.length ? `<h2>Keep attachments</h2>${p.attachments.map((a, i) => `<label class="checkbox"><input type="checkbox" name="keep-${i}" checked /> ${escape(a.path ?? a.name)}</label>`).join('')}` : ''}<label for="attachments">Add attachments</label><input id="attachments" name="attachments" type="file" multiple /><label for="package-paths">Package paths (one per new file, optional)</label><textarea id="package-paths" name="package-paths" placeholder="scripts/example.txt"></textarea><p class="meta">At most eight files, each at most 25,000,000 bytes (25 MB). Skill attachments use relative paths; SKILL.md is the text above. File and image artifacts use the first kept or new file as primary. No files are executed or remotely fetched.</p><p id="upload-status" role="status"></p><button type="submit">Save artifact</button></form></section>`);
  const fields = () => {
    const type = read('artifact-type');
    root.querySelector('#type-fields')!.innerHTML = type === 'link' ? `<label for="link-url">URL</label><input id="link-url" name="link-url" type="url" required value="${escape(p?.content.kind === 'link' ? p.content.url : '')}" /><label for="link-summary">Summary</label><textarea id="link-summary" name="link-summary">${escape(p?.content.kind === 'link' ? p.content.summary : '')}</textarea><label for="artifact-body">Notes</label><textarea id="artifact-body" name="artifact-body">${escape(p?.content.kind === 'link' ? p.content.notes : '')}</textarea>` : `${type === 'data' ? `<label for="data-format">Data format</label><select id="data-format" name="data-format">${['json','csv','toml','yaml','sqlite'].map(f => `<option ${p?.content.kind === 'data' && p.content.format === f ? 'selected' : ''}>${f}</option>`).join('')}</select><p>Attach an original data file, or enter text below. SQLite requires a file.</p>` : ''}${['file','image'].includes(type) ? '<p>Attach a primary file. Validated PNG, JPEG, GIF and WebP images have a local preview; other files are download-only.</p>' : `<label for="artifact-body">${type === 'skill' ? 'SKILL.md' : type === 'prompt' ? 'Prompt text' : 'Body (plain text; Markdown is not executed)'}</label><textarea id="artifact-body" name="artifact-body" ${['skill','prompt'].includes(type) ? 'required' : ''}>${escape(p ? artifactText(p) : '')}</textarea>`}`;
  };
  fields(); root.querySelector('#artifact-type')?.addEventListener('change', fields);
  root.querySelectorAll<HTMLButtonElement>('[data-tag]').forEach(button => button.addEventListener('click', () => {
    const tags = read('tags').split(',').map(t => t.trim()).filter(Boolean), mapped = suggestedArtifact(button.dataset.tag!, tags)!;
    (root.querySelector('#tags') as HTMLInputElement).value = mapped.tags.join(', ');
  }));
  form('artifact-form', async f => {
    const files = Array.from((f.elements.namedItem('attachments') as HTMLInputElement).files ?? []);
    const kept = (p?.attachments ?? []).filter((_, i) => new FormData(f).has(`keep-${i}`));
    if (files.length + kept.length > MAX_ARTIFACT_ATTACHMENTS) throw new Error('At most eight attachments are allowed.');
    if (files.some(file => file.size > MAX_BLOB_BYTES)) throw new Error('Files can be at most 25,000,000 bytes (25 MB).');
    const type = read('artifact-type') as ArtifactType, paths = input(f, 'package-paths').split('\n').map(s => s.trim()).filter(Boolean);
    if (paths.length && paths.length !== files.length) throw new Error('Supply one package path per new file.');
    const newPaths = files.map((file, i) => paths[i] ?? (type === 'skill' ? file.name : undefined));
    const allPaths = [...kept.map(a => a.path), ...newPaths].filter((path): path is string => path !== undefined);
    if (allPaths.some(path => !validPackagePath(path) || type === 'skill' && path === 'SKILL.md') || new Set(allPaths).size !== allPaths.length) throw new Error('Package paths must be distinct relative paths, without traversal or SKILL.md.');
    if (type === 'skill' && kept.some(a => !a.path)) throw new Error('Every skill attachment needs a package path.');
    if (['file','image'].includes(type) && !files.length && !kept.length) throw new Error('Attach a primary file.');
    const attachments = kept.slice();
    for (const [i, file] of files.entries()) { root.querySelector('#upload-status')!.textContent = `Encrypting and uploading ${i + 1} of ${files.length}…`; attachments.push(await uploadAttachment(ctx, file, newPaths[i])); }
    const text = input(f, 'artifact-body');
    let content: ArtifactContent;
    switch (type) {
      case 'skill': content = { kind: type, skill: text }; break;
      case 'prompt': content = { kind: type, text }; break;
      case 'document': content = { kind: type, markdown: text }; break;
      case 'file': case 'image': content = { kind: type, primary: attachments[0]!.blob.id }; break;
      case 'data': content = { kind: type, format: input(f, 'data-format') as 'json' | 'csv' | 'toml' | 'yaml' | 'sqlite', ...(attachments.length ? { primary: attachments[0]!.blob.id } : { text }) }; break;
      case 'link': content = { kind: type, url: input(f, 'link-url'), summary: input(f, 'link-summary'), notes: text }; break;
    }
    const payload: ArtifactPayload = { title: input(f, 'artifact-title'), tags: [...new Set(input(f, 'tags').split(',').map(s => s.trim()).filter(Boolean))], content, attachments };
    const saved = await saveArtifact(ctx, payload, previous ? { id: previous.state.id, author: previous.state.author, head: previous.state.head } : undefined);
    navigate(`/journeys/${id}/artifacts/${saved}`);
  });
}

async function membersScreen(id: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  const pendingRotation = ctx.state.pendingRotation;
  const holder = isPersonGuide(ctx.state, ctx.principal);
  const pending = holder ? (await api<{ pending: { principal: string; recipient: string; signingKey: string; support: number; expires: number | null }[] }>(`/journeys/${id}/invites/pending`, 'GET', undefined, ctx.principal)).pending : [];
  const links = new Map((await api<{ links: { memberId: string; expiresAt: number }[] }>(`/journeys/${id}/agent-links`, 'GET', undefined, ctx.principal)).links.map(link => [link.memberId, link]));
  const linkNote = (memberId: string, member: Member): string => `<p class="notice link-note">Agent link. Anyone with the link can read this journey until ${escape(member.expiresAt ?? '')} or until you remove this agent. Wayfinding's server decrypts the journey while it answers the link.</p>${ownsAgent(ctx.state, ctx.principal, memberId) ? `<details id="renew-${escape(memberId)}" class="renew"${location.hash === `#renew-${memberId}` ? ' open' : ''}><summary>Extend access</summary><form class="renew-form" data-renew="${escape(memberId)}"><label for="renew-days-${escape(memberId)}">Keep the link working for</label><select id="renew-days-${escape(memberId)}" name="renew-days"><option value="1">1 day from now</option><option value="7" selected>7 days from now</option><option value="30">30 days from now</option></select><p class="meta">The link stays the same. You confirm with your passkey.</p><div class="actions"><button type="submit">Extend with passkey</button></div></form></details>` : ''}`;
  const canAdd = replayControl(ctx.state, ctx.principal, 'Add', undefined, { id: newId(), kind: 'agent', addedBy: ctx.principal, scope: 'read', recipient: ctx.keys.recipient, signingKey: ctx.keys.signingKey }).transition.$ === 'Accepted';
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><h1>People in this journey</h1><p>Only journey members can see who is here. People who manage members are marked below.</p><label class="checkbox" for="show-my-email"><input type="checkbox" id="show-my-email" ${ctx.state.members[ctx.principal]?.profile?.email ? 'checked' : ''} ${!canControl(ctx.state, ctx.principal, 'Profile', ctx.principal) ? 'disabled' : ''} /> Show my email to people in this journey</label>${pendingRotation ? '<p class="notice">Key update pending. A person who manages members can finish it on their next visit.</p>' : ''}<ul class="list">${Object.entries(ctx.state.members).map(([memberId, { member, grants, profile }]) => `<li><strong>${member.kind === 'agent' ? escape(memberName(member)) : escape(profile?.name || (member.support ? 'Wayfinding support (Hypha)' : 'Person'))}${memberId === ctx.principal ? ' (you)' : ''}</strong>${member.kind === 'person' && profile?.email ? `<p>${escape(profile.email)}</p>` : ''}<p class="meta">${escape(memberId)} · ${isPersonGuide(ctx.state, memberId) ? 'Guide' : 'Member'} · ${effectiveScope(ctx.state, memberId) === 'readwrite' ? 'Read-write' : 'Read-only'}${member.kind === 'agent' || member.support ? ` · ${links.has(memberId) ? 'Agent link · ' : ''}${escape(member.scope ?? 'readwrite')} · ${escape(member.expiresAt ?? 'session')}` : ''}</p>${links.has(memberId) ? linkNote(memberId, member) : ''}${canRenameAgent(ctx.state, ctx.principal, memberId) || canControl(ctx.state, ctx.principal, 'Remove', memberId) || holder ? '<div class="actions">' : ''}${canRenameAgent(ctx.state, ctx.principal, memberId) ? `<button class="secondary" data-rename="${escape(memberId)}">Rename</button>` : ''}${canControl(ctx.state, ctx.principal, 'Remove', memberId) && memberId !== ctx.principal ? `<button class="secondary" data-remove="${escape(memberId)}">Remove</button>` : ''}${canControl(ctx.state, ctx.principal, 'Guide', memberId, !isPersonGuide(ctx.state, memberId)) ? `<button class="secondary" data-grant="${escape(memberId)}">${isPersonGuide(ctx.state, memberId) ? 'Stop managing people' : 'Let manage people'}</button>` : ''}${canControl(ctx.state, ctx.principal, 'RoleChange', memberId) ? `<button class="secondary" data-role="${escape(memberId)}">${effectiveScope(ctx.state, memberId) === 'read' ? 'Make read-write' : 'Make read-only'}</button>` : ''}${canRenameAgent(ctx.state, ctx.principal, memberId) || canControl(ctx.state, ctx.principal, 'Remove', memberId) || holder ? '</div>' : ''}</li>`).join('')}</ul><div class="actions"><button id="leave" class="secondary" ${canControl(ctx.state, ctx.principal, 'Remove', ctx.principal) ? '' : 'disabled'}>Leave journey</button></div></section>${canAdd ? `<section class="panel" id="agent-link-panel"><h2>Add agent by link</h2><p>For an agent that can read a web page but can't reach Wayfinding, such as Claude Cowork. It gets read-only access through a link.</p><form id="agent-link-form"><label for="link-name">Agent name</label><input id="link-name" name="link-name" maxlength="60" required /><label for="link-days">Link lasts</label><select id="link-days" name="link-days"><option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option></select><p class="notice">Anyone with this link can read this journey until it expires or you remove it. Wayfinding's server decrypts the journey while it answers the link.</p><div class="actions"><button type="submit">Create link with passkey</button></div></form></section>` : ''}${holder ? `<section class="panel"><h2>Share this journey with other people</h2><form id="invite-form"><label for="invite-email">Email addresses (separate with commas)</label><input id="invite-email" name="invite-email" type="text" placeholder="friend@example.org" /><label for="invite-scope">Invitation</label><select id="invite-scope" name="invite-scope"><option value="person">Invite a person</option><option value="support">Invite Wayfinding support</option></select><p class="meta">Support joins like any other person. Their access ends after seven days.</p><div class="actions"><button type="submit" id="invite-send">Send invitation</button><button type="button" id="invite-link-only" class="secondary">Copy link instead</button></div></form><div id="invitation"></div></section><section class="panel"><h2>Waiting to join</h2><ul class="list">${pending.length ? pending.map(row => `<li><code>${escape(row.principal)}</code>${row.support ? ' · Wayfinding support (Hypha), read only' : ''} <button data-let-in="${escape(row.principal)}">Let in</button></li>`).join('') : '<li>No one is waiting.</li>'}</ul></section>` : ''}`);
  if (holder) {
    const settings = ctx.state.settings!;
    const section = document.createElement('section'); section.className = 'panel';
    section.innerHTML = `<h2>Journey settings</h2><form id="settings-form"><label for="settings-name">Journey name</label><input id="settings-name" name="settings-name" value="${escape(settings.name)}" required /><label for="settings-description">Description</label><textarea id="settings-description" name="settings-description">${escape(settings.description)}</textarea><label for="default-role">New people start with</label><select id="default-role" name="default-role"><option value="read-only" ${settings.defaultRole === 'read-only' ? 'selected' : ''}>Read-only</option><option value="read-write" ${settings.defaultRole === 'read-write' ? 'selected' : ''}>Read-write</option></select><p>Private journey · Invitation-only. Visibility and other joining policies are not available yet.</p><button type="submit">Save settings</button></form>`;
    root.querySelector('main')!.append(section);
    form('settings-form', async f => { const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys); await appendEntry(latest, 'journey.settings', { name: input(f, 'settings-name'), description: input(f, 'settings-description'), defaultRole: input(f, 'default-role'), visibility: 'private', joiningPolicy: 'invitation-only' }); await membersScreen(id); });
  }
  const profile = document.createElement('section'); profile.className = 'panel';
  profile.innerHTML = `<h2>Your name in this journey</h2><form id="journey-profile"><label for="journey-name">Your name</label><input id="journey-name" name="journey-name" maxlength="60" value="${escape(ctx.state.members[ctx.principal]?.profile?.name ?? '')}" /><button type="submit">Save my name</button></form>`;
  root.querySelector('main')!.append(profile);
  form('journey-profile', async f => { const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys); const email = latest.state.members[latest.principal]?.profile?.email; await appendEntry(latest, 'member.profile', { id: latest.principal, name: input(f, 'journey-name'), ...(email ? { email } : {}) }); await membersScreen(id); });
  root.querySelectorAll<HTMLButtonElement>('[data-role]').forEach(button => button.addEventListener('click', () => perform(async () => { const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys); const target = button.dataset.role!; await appendEntry(latest, 'member.role', { member: target, role: effectiveScope(latest.state, target) === 'read' ? 'read-write' : 'read-only' }); await membersScreen(id); })));
  if (location.hash.startsWith('#renew-')) root.querySelector(location.hash)?.scrollIntoView();
  const fresh = async () => { const latest = await context(id); if (!latest) throw new Error('Sign in again.'); return latest; };
  form('agent-link-form', async f => {
    const name = String(new FormData(f).get('link-name') ?? '');
    if (!validAgentName(name)) throw new Error('Agent name must be trimmed, 1–60 characters and contain no control characters.');
    const days = Number(input(f, 'link-days'));
    await passkeyConfirmation();
    const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys);
    const identity = await createAgeIdentity(), signing = await createSigningIdentity(); // Only the public signing key is kept: a read-only agent never signs.
    const started = await api<{ id: string; code: string }>('/agent-sessions', 'POST', { journeyId: id, agentPublicKey: { recipient: identity.recipient, signingKey: signing.publicKey }, requestedScope: 'read', name, keyStorage: 'link', remembered: true });
    const agent = await api<{ principal: string }>(`/agent-sessions/${started.id}`);
    const expiresAt = Date.now() + days * 86_400_000;
    const member: Member = { id: agent.principal, kind: 'agent', recipient: identity.recipient, signingKey: signing.publicKey, addedBy: latest.principal, name, scope: 'read', expiresAt: new Date(expiresAt).toISOString() };
    const control = await makeControl(latest, 'member.add', { member, grants: [], kind: 'agent' });
    const [wrap] = await wrapJourneyKey(currentKey(latest), [{ id: member.id, recipient: member.recipient }]);
    await api(`/agent-sessions/${started.id}/approve`, 'POST', { code: started.code, principal: latest.principal, scope: 'read', expiresAt, wrap: wrap!.ciphertext, control });
    const secret = newLinkSecret();
    await api(`/journeys/${id}/agent-links`, 'POST', { sessionId: started.id, hash: await linkLookupHash(secret), blob: await sealLinkIdentity(secret, identity.identity, id, member.id) }, latest.principal);
    // The link appears here once. Only its hash and the sealed identity are stored, so it cannot be shown again.
    root.querySelector('#agent-link-panel')!.innerHTML = `<h2>Link for ${escape(name)}</h2><p class="notice" role="alert">Anyone with this link can read this journey until it expires or you remove it. Wayfinding's server decrypts the journey while it answers the link.</p><p>Copy it now and give it to your agent. It expires on ${escape(member.expiresAt!)}. You won't be able to see it again, but you can extend or remove access below.</p><pre id="agent-link-copy-value">${escape(`${location.origin}/a/${secret}`)}</pre><div class="actions"><button id="agent-link-copy" class="secondary">Copy link</button><button id="agent-link-done">Done</button></div><p id="copy-status" role="status"></p>`;
    copy('agent-link-copy');
    root.querySelector('#agent-link-done')?.addEventListener('click', () => perform(() => membersScreen(id)));
  });
  root.querySelectorAll<HTMLFormElement>('.renew-form').forEach(renew => renew.addEventListener('submit', event => { event.preventDefault(); const button = renew.querySelector<HTMLButtonElement>('button[type=submit]'); if (button) button.disabled = true; perform(async () => { try {
    const target = renew.dataset.renew!, expiresAt = Date.now() + Number(input(renew, 'renew-days')) * 86_400_000;
    const current = links.get(target)?.expiresAt ?? 0;
    if (expiresAt <= current) throw new Error('This link already lasts longer than that. Choose a longer time.');
    await passkeyConfirmation();
    const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys);
    const control = await makeControl(latest, 'member.renew', { id: target, expiresAt: new Date(expiresAt).toISOString() });
    await api(`/journeys/${id}/agent-links/${target}/renew`, 'POST', { control, expiresAt }, latest.principal);
    await membersScreen(id);
  } finally { if (button?.isConnected) button.disabled = false; } }); }));
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
  root.querySelectorAll<HTMLButtonElement>('[data-grant]').forEach(button => button.addEventListener('click', () => perform(async () => { const latest = await fresh(); const target = button.dataset.grant!; await appendEntry(latest, isPersonGuide(latest.state, target) ? 'grant.remove' : 'grant.add', { member: target, grant: 'members.manage' }); await membersScreen(id); })));
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
    if (!canControl(latest.state, latest.principal, 'Remove', latest.principal)) throw new Error('The last person who manages members cannot leave. Grant that role to someone else first.');
    await passkeyConfirmation();
    await appendEntry(latest, 'member.remove', { member: latest.principal });
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
        if (name && canControl(ctx.state, principal, 'Profile', principal)) await appendEntry(ctx, 'member.profile', { id: principal, name });
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
  const agent = await api<{ status: string; journeyId: string; principal: string; recipient: string; signingKey: string; requestedScope: 'read' | 'readwrite'; remembered: boolean; keyStorage: 'memory' | 'file'; name: string | null }>(`/agent-sessions/${sessionId}`);
  const keys = getPersonKeys(); if (!keys) { signIn(`/agent-sessions/${sessionId}`); return; }
  if (agent.status !== 'pending') { render(`<section class="panel"><h1>Agent request ${escape(agent.status)}</h1></section>`); return; }
  const ctx = await context(agent.journeyId); if (!ctx) return;
  const hours = agent.remembered ? '<option value="8">8 hours</option><option value="168">7 days</option><option value="2160">90 days</option>' : '<option value="1">1 hour</option><option value="8">8 hours</option>';
  render(`<section class="panel"><h1>Approve an agent</h1><p>Check the six-digit code shown by the agent before granting access. Choose what it can do and for how long.</p>${agent.keyStorage === 'file' ? '<p>This agent will keep its keys in a file on its machine.</p>' : ''}<form id="agent-form"><label for="agent-code">Six-digit code</label><input id="agent-code" name="agent-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required /><label for="agent-name">Name</label><input id="agent-name" name="agent-name" maxlength="60" value="${escape(agent.name ?? 'Agent')}" required /><label for="agent-scope">Access</label><select id="agent-scope" name="agent-scope"><option value="read">Read only</option><option value="readwrite">Read and write</option></select><label for="agent-hours">How long?</label><select id="agent-hours" name="agent-hours">${hours}</select><div class="actions"><button type="submit">Confirm with passkey</button></div></form></section>`);
  form('agent-form', async f => {
    const name = String(new FormData(f).get('agent-name') ?? '');
    if (!validAgentName(name)) throw new Error('Agent name must be trimmed, 1–60 characters and contain no control characters.');
    await passkeyConfirmation();
    const latest = await verifiedJourney(ctx.id, ctx.principal, ctx.keys);
    const scope = input(f, 'agent-scope') as 'read' | 'readwrite', expiresAt = Date.now() + Number(input(f, 'agent-hours')) * 3_600_000;
    const member = { id: agent.principal, kind: 'agent' as const, recipient: agent.recipient, signingKey: agent.signingKey, addedBy: ctx.principal, name, scope, expiresAt: new Date(expiresAt).toISOString() };
    const control = await makeControl(latest, 'member.add', { member, grants: [], kind: 'agent' });
    const [wrap] = await wrapJourneyKey(currentKey(latest), [{ id: member.id, recipient: member.recipient }]);
    await api(`/agent-sessions/${sessionId}/approve`, 'POST', { code: input(f, 'agent-code'), principal: latest.principal, scope, expiresAt, wrap: wrap!.ciphertext, control });
    render(`<section class="panel"><h1>Agent approved</h1><p>You can see it in your journey's people and agents list.</p><a href="/journeys/${latest.id}/members">People &amp; agents</a></section>`);
  });
}
async function exportScreen(id: string): Promise<void> {
  const ctx = await context(id); if (!ctx) return;
  const recipient = itemVersions(await allRecords(ctx)).find(v => v.item.itemType === 'recovery' && !v.deleted)?.item.body ?? '';
  render(`<section class="panel"><p><a href="/journeys/${id}">← Back to journey</a></p><h1>Export your journey</h1><p>Your export contains the signed journey history, encrypted artifacts, comments and surviving files, and your key wraps. Deleted artifacts retain signed proofs and encrypted metadata, but their files are unavailable. Previously downloaded copies cannot be recalled. The download is encrypted to you and, by default, your recovery key. Save both to open it later.</p><form id="export-form"><label for="recovery-recipient">Recovery recipient (age public key)</label><input id="recovery-recipient" name="recovery-recipient" required placeholder="age1…" value="${escape(recipient)}" /><div class="actions"><button type="submit">Download encrypted export</button></div></form></section>`);
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
  disposeViewer?.(); disposeViewer = undefined;
  const path = location.pathname;
  if (!/^\/journeys\//.test(path)) closePrivateVaults();
  render('<section class="panel"><p role="status">Loading…</p></section>');
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
    if (sub === 'members' || sub === 'people') return membersScreen(id);
    if (sub === 'agent') return agentPromptScreen(id);
    if (sub === 'export') return exportScreen(id);
    if (sub === 'add') return artifactForm(id);
    if (sub === 'projects') return projectsScreen(id);
    const project = /^projects\/([0-7][0-9A-HJKMNP-TV-Z]{25})$/.exec(sub);
    if (project) return projectScreen(id, project[1]!);
    const artifact = /^artifacts\/([0-7][0-9A-HJKMNP-TV-Z]{25})(?:\/(edit))?$/.exec(sub);
    if (artifact) return artifact[2] ? artifactForm(id, artifact[1]) : artifactScreen(id, artifact[1]!);
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
