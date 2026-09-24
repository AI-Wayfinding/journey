import { importSigningKey } from '@ai-wayfinding/core';
import type { SigningIdentity } from '@ai-wayfinding/core';
export interface AgentHeaders { 'X-Agent-Timestamp': string; 'X-Agent-Nonce': string; 'X-Agent-Signature': string }
/** Sign the exact bytes sent to the server, including the path and query string. */
export async function signedHeaders(privateKey: SigningIdentity['privateKey'], method: string, path: string, body: string, timestamp = String(Date.now()), nonce = crypto.randomUUID()): Promise<AgentHeaders> {
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))).toString('base64url');
  const message = [method.toUpperCase(), path, hash, timestamp, nonce].join('\n');
  const signature = await crypto.subtle.sign('Ed25519', await importSigningKey(privateKey), new TextEncoder().encode(message));
  return { 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': Buffer.from(signature).toString('base64url') };
}
