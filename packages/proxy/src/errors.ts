import * as z from 'zod';
import {SdkHttpError,UnauthorizedError} from '@modelcontextprotocol/client';
const messages={refused:'Remote operation refused',lifecycle:'Remote lifecycle refused',stale:'Remote state changed; synchronize and retry',permission:'Remote permission denied',quota:'Remote capacity exhausted',authentication:'Sign in again to re-authorise the connector',unavailable:'Remote service unavailable',response:'Invalid remote response',mode:'Server must report sealed-v1; downgrade refused'} as const;
export type RemoteCode=keyof typeof messages;
/** Only exact, fixed server diagnostics may cross the local-agent boundary.
 * Never echo arbitrary remote prose, identifiers, tokens or appended instructions. */
const publicReasons=[
 'Offer is not available','Target is not entitled to audience','Authenticated device binding required',
 'Current group device required','Current device required for retained history','Browser leaf binding required',
 'Offline checkpoint expired; rejoin through a live member','Sealed group CAS mismatch',
 'Content revision changed','Prepared epoch is stale','Sealed epoch mismatch',
 'Task is final','Task access refused','Task audience refused','Interview is private',
 'Sealed metadata refused by coordination rules','Sealed operation refused by coordination rules',
 'Only own devices or server-ineligible devices may be removed','Only own device may request automatic admission',
 'Complete onboarding before using browser controls','Fresh passkey enrollment required',
 'Registered wrapping passkey required','Browser device revoked',
] as const;
type PublicReason=typeof publicReasons[number];
export class RemoteFailure extends Error {readonly code:RemoteCode;constructor(code:RemoteCode,reason?:PublicReason){super(reason?`${messages[code]}: ${reason}`:messages[code]);this.code=code;}}
export function transportFailure(error:unknown):RemoteFailure {return new RemoteFailure(error instanceof UnauthorizedError||error instanceof SdkHttpError&&error.status===401?'authentication':'unavailable');}
export function remoteFailure(text:string):RemoteFailure {
 const reason=publicReasons.find(reason=>reason===text);
 let code:RemoteCode='refused';
 if(/Content revision changed|Prepared epoch is stale|Sealed epoch mismatch/.test(text))code='stale';
 else if(/Task is final|Sealed metadata refused by coordination rules|Sealed operation refused by coordination rules/.test(text))code='lifecycle';
 else if(/quota|budget|capacity/i.test(text))code='quota';
 else if(/forbidden|permission|authority|not eligible|Interview is private|Task access refused|Task audience refused|device.keys/i.test(text))code='permission';
 return new RemoteFailure(code,reason);
}
export class PartialMoveFailure extends Error {
 readonly receipt:{status:'partial';sourceArtifactId:string;destinationArtifactId:string;sourceState:'unknown';destinationState:'created'};
 constructor(sourceArtifactId:string,destinationArtifactId:string){super('Move incomplete; destination exists; source deletion is unconfirmed. Inspect both records before retrying.');this.receipt={status:'partial',sourceArtifactId,destinationArtifactId,sourceState:'unknown',destinationState:'created'};}
}
export class SafetyNumberChangedError extends Error {constructor(){super('Account safety number changed; use account_safety_numbers to view it, compare outside Wayfinding, then use account_trust_key with the compared number before synchronizing.');}}
export class SafetyNumberMismatchError extends Error {constructor(){super('Account safety number did not match; compare it outside Wayfinding and try again');}}
export function localError(error:unknown):string{return error instanceof SafetyNumberMismatchError||error instanceof SafetyNumberChangedError?error.message:error instanceof PartialMoveFailure?error.message:error instanceof RemoteFailure?error.message:error instanceof z.ZodError?'Invalid local tool input':'Local operation failed; synchronize or reopen the device';}
