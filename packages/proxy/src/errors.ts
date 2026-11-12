import * as z from 'zod';
const messages={refused:'Remote operation refused',stale:'Remote state changed; synchronize and retry',permission:'Remote permission denied',quota:'Remote capacity exhausted',unavailable:'Remote service unavailable',response:'Invalid remote response',mode:'Server must report sealed-v1; downgrade refused'} as const;
export type RemoteCode=keyof typeof messages;
/** Remote prose is used only for bounded classification, never delivered to the local agent. */
export class RemoteFailure extends Error {readonly code:RemoteCode;constructor(code:RemoteCode){super(messages[code]);this.code=code;}}
export function remoteFailure(text:string):RemoteFailure {
 if(/Content revision changed|Prepared epoch is stale|Sealed epoch mismatch/.test(text))return new RemoteFailure('stale');
 if(/quota|budget|capacity/i.test(text))return new RemoteFailure('quota');
 if(/forbidden|permission|authority|not eligible/i.test(text))return new RemoteFailure('permission');
 return new RemoteFailure('refused');
}
export function localError(error:unknown):string{return error instanceof RemoteFailure?error.message:error instanceof z.ZodError?'Invalid local tool input':'Local operation failed; synchronize or reopen the device';}
