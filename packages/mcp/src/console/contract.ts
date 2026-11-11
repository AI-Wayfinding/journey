import * as z from 'zod';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { CoordinationBackend, ToolData } from '../commands.ts';
import type { CardChange, ClientIdentity } from '../agents.ts';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

export const registration = z.object({ id: z.string().min(1).max(2048), rawId: z.string().max(2048), type: z.literal('public-key'), clientExtensionResults: z.object({}).strip(),
  response: z.object({ clientDataJSON: z.string().max(8192), attestationObject: z.string().max(65536), transports: z.array(z.string()).max(10).optional() }).strip() }).strip();
export const browserBinding = z.object({ deviceId: z.string().regex(/^device_[0-9a-f-]{36}$/), verificationKey: z.string().max(128), data: z.string().max(90000) }).strict();
const browserFields = { browserId: z.string().uuid(), credentialId: z.string().min(1).max(2048), device: browserBinding };
export const passkeyOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('browser_list') }).strict(),
  z.object({ op: z.literal('browser_check'), browserId: z.string().uuid() }).strict(),
  z.object({ op: z.literal('browser_begin'), ...browserFields }).strict(),
  z.object({ op: z.literal('browser_finish'), ...browserFields, assertion: z.object({ id: z.string(), rawId: z.string(), type: z.literal('public-key'), clientExtensionResults: z.object({}).strip(), response: z.object({ clientDataJSON: z.string(), authenticatorData: z.string(), signature: z.string(), userHandle: z.string().optional() }).strict() }).strict() }).strict(),
  z.object({ op: z.literal('list') }).strict(),
  z.object({ op: z.literal('begin') }).strict(),
  z.object({ op: z.literal('finish'), credential: registration }).strict(),
  z.object({ op: z.literal('delete'), id: z.string().min(1).max(2048) }).strict(),
  z.object({ op: z.literal('rename'), id: z.string().min(1).max(2048), name: z.string().trim().max(60) }).strict(),
]);
export type PasskeyOperation = z.infer<typeof passkeyOperation>;
const text = z.string().min(1).max(200);
export const consoleRecord = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('oauth'), state: text, verifier: text, returnTo: z.string().max(300).optional(), expiresAt: z.number().int().nonnegative().safe() }).strict(),
  z.object({ kind: z.literal('session'), subject: text, clientId: text, csrf: text, signedInAt: z.number().int().nonnegative().safe().optional(), expiresAt: z.number().int().nonnegative().safe() }).strict(),
]);
export type ConsoleRecord = z.infer<typeof consoleRecord>;
export const recordOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('put'), id: text, record: consoleRecord }).strict(),
  z.object({ op: z.enum(['read', 'take', 'delete']), id: text }).strict(),
]);
export type RecordOperation = z.infer<typeof recordOperation>;
export interface ConsoleBackend extends CoordinationBackend {
  readonly sealedMode?:boolean;
  sealedExecute?(subject:string,tool:string,input:unknown,clientId?:string):Promise<ToolData>;
  whoami?(subject:string,clientId:string):Promise<ToolData>;
  oauth(operation: import('../oauth-contract.ts').OAuthOperation): Promise<import('../oauth-contract.ts').OAuthResult>;
  consentAgent(subject: string, id: string, consent: import('../oauth-contract.ts').AgentConsent, assertion?: AuthenticationResponseJSON): Promise<string>;
  manageAgent(identity: ClientIdentity, agentId: string, name: string, journeys: string[]): Promise<void>;
  passkey(identity: ClientIdentity, operation: PasskeyOperation): Promise<ToolData>;
  consoleRecord(operation: RecordOperation): Promise<ConsoleRecord | undefined>;
  beginAuthorization(identity: ClientIdentity, change: CardChange): Promise<{ challenge: string }>;
  completeAuthorization(identity: ClientIdentity, change: CardChange, assertion: AuthenticationResponseJSON | undefined): Promise<ToolData>;

}
export interface ConsoleOptions {
  secret: string;
  backend: ConsoleBackend;
  send?: typeof fetch;
  now?: () => number;
}
export interface ConsoleConfig extends ConsoleOptions {
  verifier: OAuthTokenVerifier;
  resource: URL;
  issuer: string;
}
