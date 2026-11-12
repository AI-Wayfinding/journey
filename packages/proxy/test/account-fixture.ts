import type {MemoryBackend} from '../../mcp/src/backend.ts';
import {installTestAccountIdentity,trustedAccountRemote,type TestAccountIdentity} from '../../mcp/test/account-fixture.ts';
import {SealedClient,type SealedRemote} from '../src/sealed-client.ts';
import {WayfindingProxy} from '../src/proxy.ts';
import type {LocalStore} from '../src/store.ts';
import {connectionClaimSchema,generateSigningKey,signConnection} from '../../shared/account-identity.ts';

const installed=new WeakMap<MemoryBackend,Map<string,Promise<TestAccountIdentity>>>();

export function testAccount(backend:MemoryBackend,subject:string):Promise<TestAccountIdentity>{
 let subjects=installed.get(backend);
 if(!subjects){subjects=new Map();installed.set(backend,subjects);}
 let account=subjects.get(subject);
 if(!account){account=installTestAccountIdentity(backend,subject);subjects.set(subject,account);}
 return account;
}

export async function trustedRemote(backend:MemoryBackend,remote:SealedRemote,subject:string):Promise<{account:TestAccountIdentity;remote:SealedRemote}>{
 const account=await testAccount(backend,subject);
 return {account,remote:trustedAccountRemote(remote,account)};
}

export async function openTestSealed<T extends SealedRemote>(backend:MemoryBackend,remote:T,store:LocalStore,subject:string,personId?:string){
 const trusted=await trustedRemote(backend,remote,subject);
 const id=personId??String((await backend.execute(subject,{tool:'account_read',input:{}})).personId);
 const client=await SealedClient.open(trusted.remote,store,id,{endorse:async claim=>(await trusted.account.artifacts(claim)).certificate});
 return {...trusted,rawRemote:remote,client};
}

export async function openTestProxy(backend:MemoryBackend,remote:SealedRemote,store:LocalStore,subject:string){
 const trusted=await trustedRemote(backend,remote,subject);
 const proxy=await WayfindingProxy.open(trusted.remote,store,{endorse:async claim=>(await trusted.account.artifacts(claim)).certificate});
 return {...trusted,proxy};
}

export async function syntheticAccountIdentity(){
 const key=await generateSigningKey();
 return {
  accountKey:{identity:{publicKey:key.publicKey,generation:0},recoveryWrap:{format:'wayfinding-browser-vault-1' as const,iv:'AA==',ciphertext:'AA=='}},
  approve:async(input:Record<string,unknown>)=>({certificate:await signConnection(key.privateKey,connectionClaimSchema.parse(input.claim))}),
 };
}
