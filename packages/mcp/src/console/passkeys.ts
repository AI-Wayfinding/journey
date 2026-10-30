import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { Account } from '../accounts.ts';
import type { KeyValueStorage } from '../storage.ts';
import { Refused, type ToolData } from '../commands.ts';
import type { PasskeyOperation } from './contract.ts';

export async function managePasskey(account: Account, accounts: Account[], storage: KeyValueStorage, operation: PasskeyOperation, now: number): Promise<ToolData> {
  const key = `passkey-registration:${account.personId}`;
  if (operation.op === 'list') return { passkeys: account.passkeys.map(c => ({ id: c.id })) };
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
    await storage.put(key, JSON.stringify({ challenge: options.challenge, expiresAt: now + 300_000 }));
    return { ...options };
  }
  let pending: { challenge: string; expiresAt: number } | null = null;
  const raw = await storage.get(key);
  try { pending = typeof raw === 'string' ? JSON.parse(raw) as { challenge: string; expiresAt: number } : null; }
  catch { throw new Refused('Invalid stored registration'); }
  if (!pending || pending.expiresAt <= now) throw new Refused('Fresh passkey registration required');
  const verified = await verifyRegistrationResponse({ response: operation.credential, expectedChallenge: pending.challenge,
    expectedOrigin: 'https://poc.wayfinding.support', expectedRPID: 'poc.wayfinding.support', requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
  if (!verified.verified) throw new Refused('Passkey registration refused');
  const credential = verified.registrationInfo.credential;
  if (accounts.some(a => a.passkeys.some(c => c.id === credential.id))) throw new Refused('Passkey already registered');
  if (account.passkeys.length >= 16) throw new Refused('Passkey capacity reached');
  account.passkeys.push({ id: credential.id, publicKey: [...credential.publicKey], counter: credential.counter });
  await storage.put(key, 'null');
  return { registered: true };
}
