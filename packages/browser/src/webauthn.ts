import * as z from 'zod';
import { encode, decode } from '../../proxy/src/codec.ts';
const b64url=(b:Uint8Array)=>encode(b).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const fromURL=(s:string)=>new Uint8Array(decode(s.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-s.length%4)%4)));
export async function assertion(options:Record<string,unknown>,prfSalt?:Uint8Array){
 const parsed=z.object({challenge:z.string(),rpId:z.string(),allowCredentials:z.array(z.object({id:z.string()}))}).parse(options);
 const extensions:AuthenticationExtensionsClientInputs&{prf?:{eval:{first:Uint8Array<ArrayBuffer>}}}=prfSalt?{prf:{eval:{first:new Uint8Array(prfSalt)}}}:{};
 const credential=await navigator.credentials.get({publicKey:{challenge:fromURL(parsed.challenge),rpId:parsed.rpId,allowCredentials:parsed.allowCredentials.map(c=>({id:fromURL(c.id),type:'public-key'})),userVerification:'required',timeout:60000,extensions}});
 if(!(credential instanceof PublicKeyCredential)||!(credential.response instanceof AuthenticatorAssertionResponse))throw new Error('Passkey confirmation cancelled');
 const response=credential.response,extra=z.object({prf:z.object({results:z.object({first:z.instanceof(ArrayBuffer)}).optional()}).optional()}).parse(credential.getClientExtensionResults());
 return {assertion:{id:credential.id,rawId:b64url(new Uint8Array(credential.rawId)),type:'public-key' as const,clientExtensionResults:{},response:{clientDataJSON:b64url(new Uint8Array(response.clientDataJSON)),authenticatorData:b64url(new Uint8Array(response.authenticatorData)),signature:b64url(new Uint8Array(response.signature)),...(response.userHandle?{userHandle:b64url(new Uint8Array(response.userHandle))}:{})}},prf:extra.prf?.results?new Uint8Array(extra.prf.results.first):undefined};
}
export async function evaluatePrf(credentialId:string,salt:Uint8Array){
 return (await assertion({challenge:b64url(crypto.getRandomValues(new Uint8Array(32))),rpId:location.hostname,allowCredentials:[{id:credentialId}]},salt)).prf;
}
