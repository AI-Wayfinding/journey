import * as age from 'age-encryption';
import type { Identity, Recipient } from 'age-encryption';
import { asBuffer, decode, encode, text, utf8 } from './codec.js';
export type AgeRecipient = string | Recipient;
export type AgeIdentity = string | CryptoKey | Identity;
export interface SigningIdentity { publicKey: string; privateKey: string }
export async function createAgentIdentity(): Promise<{ privateKey: CryptoKey; recipient: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
  return { privateKey: pair.privateKey, recipient: await age.identityToRecipient(pair.privateKey) };
}
export async function createAgeIdentity(): Promise<{ identity: string; recipient: string }> {
  const identity = await age.generateIdentity();
  return { identity, recipient: await age.identityToRecipient(identity) };
}
export async function deriveRecipient(identity: AgeIdentity): Promise<string> {
  if (typeof identity !== 'string' && !(identity instanceof CryptoKey)) throw new TypeError('A custom age identity cannot expose a standard recipient');
  return age.identityToRecipient(identity);
}
export async function createSigningIdentity(): Promise<SigningIdentity> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  return { publicKey: encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), privateKey: encode(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))) };
}
export async function importSigningKey(privateKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', asBuffer(decode(privateKey)), 'Ed25519', false, ['sign']);
}
export async function sealIdentity(identity: string, recipients: AgeRecipient[]): Promise<string> {
  if (!recipients.length) throw new Error('At least one recipient is required');
  const encrypter = new age.Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  return encode(await encrypter.encrypt(utf8(identity)));
}
export async function openIdentity(ciphertext: string, identities: AgeIdentity[]): Promise<string> {
  const decrypter = new age.Decrypter();
  for (const identity of identities) decrypter.addIdentity(identity);
  return text(await decrypter.decrypt(decode(ciphertext)));
}
