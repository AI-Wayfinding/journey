import * as z from 'zod';
import type { Account } from './accounts.ts';
import { capabilitySchema } from './agents.ts';

export const oauthId = z.string().min(1).max(2048);
export const clientMetadata = z.object({
  client_name: z.string().trim().min(1).max(60).default('MCP client'),
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(20),
  token_endpoint_auth_method: z.literal('none').default('none'),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).default(['code']),
});
export type OAuthClient = z.infer<typeof clientMetadata> & { client_id: string };
export const authorizationRequest = z.object({ clientId: oauthId, clientName: z.string().max(60), redirectUri: oauthId,
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), state: z.string().max(2048).optional(), expiresAt: z.number() }).strict();
export type AuthorizationRequest = z.infer<typeof authorizationRequest>;
export const agentConsent = z.object({ name: z.string().trim().min(1).max(60), capabilities: z.array(capabilitySchema).max(20), journeys: z.array(z.string().min(1).max(200)).max(128) }).strict();
export type AgentConsent = z.infer<typeof agentConsent>;
export const oauthOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('register'), client: clientMetadata }),
  z.object({ op: z.literal('client'), clientId: oauthId }),
  z.object({ op: z.literal('request'), id: oauthId, request: authorizationRequest.optional() }),
  z.object({ op: z.literal('deny'), id: oauthId }),
  z.object({ op: z.literal('consent'), id: oauthId, subject: oauthId, consent: agentConsent }),
  z.object({ op: z.literal('manage'), subject: oauthId, agentId: oauthId, name: z.string().trim().min(1).max(60).optional(), journeys: z.array(z.string().max(200)).max(128).optional() }),
  z.object({ op: z.literal('code'), id: oauthId, subject: oauthId, agentId: oauthId }),
  z.object({ op: z.literal('exchange'), code: oauthId, clientId: oauthId, redirectUri: oauthId, verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) }),
  z.object({ op: z.literal('refresh'), token: oauthId, clientId: oauthId }),
  z.object({ op: z.literal('revoke'), token: oauthId, clientId: oauthId }),
  z.object({ op: z.literal('verify'), token: oauthId }),
]);
export type OAuthOperation = z.infer<typeof oauthOperation>;
interface TokenIdentity { subject: string; personId: string; clientId: string; agentId: string }
export interface OAuthTokens { access_token: string; refresh_token: string; token_type: 'Bearer'; expires_in: number }
export type OAuthResult = { kind: 'client'; client?: OAuthClient } | { kind: 'request'; request?: AuthorizationRequest }
  | { kind: 'agent'; agentId: string } | { kind: 'code'; code: string } | { kind: 'tokens'; tokens: OAuthTokens }
  | { kind: 'access'; identity: TokenIdentity; expiresAt: number } | { kind: 'error'; error: string } | { kind: 'ok' };
export interface OAuthPort { oauth(operation: OAuthOperation): Promise<OAuthResult> }
export interface StoredToken extends TokenIdentity { hash: string; expiresAt: number; family: string; used?: boolean }
export interface OAuthState {
  clients: OAuthClient[]; requests: { id: string; request: AuthorizationRequest }[];
  codes: (TokenIdentity & { hash: string; redirectUri: string; challenge: string; expiresAt: number })[];
  access: StoredToken[]; refresh: StoredToken[];
}
export interface OAuthAccounts { accounts: Account[]; oauth?: OAuthState }
