import * as z from 'zod';
const messages={refused:'Remote operation refused',lifecycle:'Remote lifecycle refused',stale:'Remote state changed; synchronize and retry',permission:'Remote permission denied',quota:'Remote capacity exhausted',unavailable:'Remote service unavailable',response:'Invalid remote response',mode:'Server must report sealed-v1; downgrade refused'} as const;
export type RemoteCode=keyof typeof messages;
/** Remote prose is used only for bounded classification, never delivered to the local agent. */
export class RemoteFailure extends Error {readonly code:RemoteCode;constructor(code:RemoteCode){super(messages[code]);this.code=code;}}
export function remoteFailure(text:string):RemoteFailure {
 if(/Content revision changed|Prepared epoch is stale|Sealed epoch mismatch/.test(text))return new RemoteFailure('stale');
 if(/Task is final|Sealed metadata refused by coordination rules|Sealed operation refused by coordination rules/.test(text))return new RemoteFailure('lifecycle');
 if(/quota|budget|capacity/i.test(text))return new RemoteFailure('quota');
 if(/forbidden|permission|authority|not eligible|Interview is private|Task access refused|Task audience refused|device.keys/i.test(text))return new RemoteFailure('permission');
 return new RemoteFailure('refused');
}
export class PartialMoveFailure extends Error {
 readonly receipt:{status:'partial';sourceArtifactId:string;destinationArtifactId:string;sourceState:'unknown';destinationState:'created'};
 constructor(sourceArtifactId:string,destinationArtifactId:string){super('Move incomplete; destination exists; source deletion is unconfirmed. Inspect both records before retrying.');this.receipt={status:'partial',sourceArtifactId,destinationArtifactId,sourceState:'unknown',destinationState:'created'};}
}
export function localError(error:unknown):string{return error instanceof PartialMoveFailure?error.message:error instanceof RemoteFailure?error.message:error instanceof z.ZodError?'Invalid local tool input':'Local operation failed; synchronize or reopen the device';}
