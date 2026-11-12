import * as z from 'zod';
import {accountIdentitySchema,identityEventSchema,publicKeySchema,verifyIdentityEvent,type AccountIdentity,type IdentityEvent} from './account-identity.ts';

const pinSchema=z.object({publicKey:publicKeySchema,generation:z.number().int().nonnegative().safe().optional(),compared:z.boolean().optional(),history:z.array(accountIdentitySchema).default([])}).strict();
export const accountTrustSchema=z.object({version:z.literal(1),pins:z.record(z.string(),pinSchema)}).strict();
export type AccountPin=z.infer<typeof pinSchema>;
export type AccountTrust=z.infer<typeof accountTrustSchema>;
export function matchesCurrent(pin:AccountPin|undefined,identity:AccountIdentity){return !!pin&&pin.publicKey===identity.publicKey&&(pin.generation===undefined||pin.generation===identity.generation);}
export function matchesHistory(pin:AccountPin|undefined,identity:AccountIdentity){return !!pin?.history.some(old=>old.publicKey===identity.publicKey&&old.generation===identity.generation);}
export function replacePin(old:AccountPin|undefined,identity:{publicKey:string;generation?:number},compared=false):AccountPin{
 const history=[...(old?.history??[])];
 if(old&&old.publicKey!==identity.publicKey&&old.generation!==undefined&&!history.some(p=>p.publicKey===old.publicKey&&p.generation===old.generation))history.push({publicKey:old.publicKey,generation:old.generation});
 return {publicKey:identity.publicKey,...(identity.generation===undefined?{}:{generation:identity.generation}),compared,history};
}
/** A compared/current root can authenticate predecessors, never its own successor.
 * Recovery signs previousPublicKey with the NEW key. Keep the generation in the
 * pin so a valid historical key cannot silently become the current root again. */
export async function extendHistory(pin:AccountPin,personId:string,events:IdentityEvent[]):Promise<AccountPin>{
 const next={...pin,history:[...pin.history]};
 let added=true;
 while(added){added=false;for(const event of events){
  if(event.personId!==personId||event.action!=='account-key-set'||!event.previousPublicKey||event.generation===0)continue;
  const identity={publicKey:event.accountPublicKey,generation:event.generation};
  if(!matchesCurrent(next,identity)&&!matchesHistory(next,identity))continue;
  if(!await verifyIdentityEvent(event))throw new Error('Invalid signed identity log entry');
  const previous={publicKey:publicKeySchema.parse(event.previousPublicKey),generation:event.generation-1};
  const existing=next.history.find(p=>p.generation===previous.generation);
  if(existing&&existing.publicKey!==previous.publicKey)throw new Error('Conflicting historical account key');
  if(next.generation===previous.generation&&next.publicKey!==previous.publicKey)throw new Error('Conflicting pinned account key');
  if(!existing&&!matchesCurrent(next,previous)){next.history.push(previous);added=true;}
 }}
 return next;
}
/** Verify the entire view before rendering anything as verified. The journal is
 * not a completeness proof: unsigned server removals stay explicitly unsigned. */
export async function pinnedIdentityLog(pin:AccountPin,personId:string,values:unknown){
 const events=z.array(identityEventSchema).parse(values),next=await extendHistory(pin,personId,events);
 const entries=[];
 for(const event of events){
  if(event.personId!==personId)throw new Error('Identity log account mismatch');
  if(event.signature){
   if(!await verifyIdentityEvent(event))throw new Error('Invalid signed identity log entry');
   const identity={publicKey:event.accountPublicKey,generation:event.generation};
   if(!matchesCurrent(next,identity)&&!matchesHistory(next,identity))throw new Error('Identity log key is not pinned');
  }
  entries.push({...event,verified:!!event.signature});
 }
 return {pin:next,entries};
}
