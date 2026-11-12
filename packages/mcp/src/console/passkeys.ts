import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { Account } from '../accounts.ts';
import type { KeyValueStorage } from '../storage.ts';
import { Refused, type ToolData } from '../commands.ts';
import type { PasskeyOperation } from './contract.ts';
import { providerName } from './providers.ts';

export async function managePasskey(account: Account, accounts: Account[], storage: KeyValueStorage, operation: PasskeyOperation, now: number,sealedMode=false): Promise<ToolData> {
  if(sealedMode&&operation.op==='rename')throw new Refused('Passkey labels must be sealed in the private profile by an enrolled proxy');
  const key = `passkey-registration:${account.personId}`;
  if (operation.op === 'list') return { passkeys: account.passkeys.map(c => ({ id: c.id, label: sealedMode?c.id:c.name || providerName(c.aaguid) || 'Passkey', provider: sealedMode?null:providerName(c.aaguid) ?? null,
    name: sealedMode?null:c.name ?? null, createdAt: c.createdAt ?? null, lastUsedAt: c.lastUsedAt ?? null })) };
  if (operation.op === 'rename') {
    const credential = account.passkeys.find(c => c.id === operation.id);
    if (!credential) throw new Refused('Unknown owned passkey');
    if (operation.name) credential.name = operation.name; else delete credential.name;
    return { renamed: true };
  }
  if (operation.op === 'delete') {
    if (!account.passkeys.some(c => c.id === operation.id)) throw new Refused('Unknown owned passkey');
    account.passkeys = account.passkeys.filter(c => c.id !== operation.id); account.assertions = [];
    await storage.put(key, 'null'); return { deleted: true };
  }
  if (operation.op === 'begin') {
    if (account.passkeys.length >= 16) throw new Refused('Passkey capacity reached');
    const options = await generateRegistrationOptions({ rpName: 'AI Wayfinding', rpID: 'poc.wayfinding.support',
      userID: new Uint8Array(new TextEncoder().encode(account.personId)), userName: account.nickname ?? account.name,
      attestationType: 'none', supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: account.passkeys.map(c => ({ id: c.id })) });
    await storage.put(key, JSON.stringify({ challenge: options.challenge, expiresAt: now + 300_000, credentials:account.passkeys.map(k=>k.id).sort().join(','), authorized:true }));
    return { ...options };
  }
  if(operation.op!=='finish')throw new Refused('Browser enrollment uses the host enrollment path');
  let pending: { challenge: string; expiresAt: number; credentials: string; authorized: true } | null = null;
  const raw = await storage.get(key);
  try { pending = typeof raw === 'string' ? JSON.parse(raw) as { challenge: string; expiresAt: number; credentials: string; authorized: true } : null; }
  catch { throw new Refused('Invalid stored registration'); }
  if (!pending || pending.expiresAt <= now) throw new Refused('Fresh passkey registration required');
  if(pending.authorized!==true||pending.credentials!==account.passkeys.map(k=>k.id).sort().join(','))throw new Refused('Fresh authorized registration required');
  const verified = await verifyRegistrationResponse({ response: operation.credential, expectedChallenge: pending.challenge,
    expectedOrigin: 'https://poc.wayfinding.support', expectedRPID: 'poc.wayfinding.support', requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
  if (!verified.verified) throw new Refused('Passkey registration refused');
  const credential = verified.registrationInfo.credential;
  if (accounts.some(a => a.passkeys.some(c => c.id === credential.id))) throw new Refused('Passkey already registered');
  if (account.passkeys.length >= 16) throw new Refused('Passkey capacity reached');
  account.passkeys.push({ id: credential.id, publicKey: [...credential.publicKey], counter: credential.counter, ...(sealedMode?{}:{aaguid:verified.registrationInfo.aaguid}), createdAt: now });
  await storage.put(key, 'null');
  return { registered: true };
}
