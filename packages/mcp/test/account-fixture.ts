import type {MemoryBackend} from '../src/backend.ts';
import type {Account} from '../src/accounts.ts';
import type {SealedRemote} from '../../proxy/src/sealed-client.ts';
import {
  connectionClaim,
  connectionClaimSchema,
  accountKeyRecordSchema,
  generateSigningKey,
  signConnection,
  signIdentityEvent,
  signPackage,
  signValue,
  type ConnectionCertificate,
  type ConnectionClaim,
  type DeviceRegistration,
  type IdentityEvent,
  type SigningKey,
} from '../../shared/account-identity.ts';

const recoveryWrap={format:'wayfinding-browser-vault-1' as const,iv:'AA==',ciphertext:'AA=='};

export type TestAccountIdentity=Awaited<ReturnType<typeof installTestAccountIdentity>>;

/** Install a real account key after seeding the synthetic first-passkey prerequisite. */
export async function installTestAccountIdentity(backend:MemoryBackend,subject:string,clientId='test-console',signedInAt?:number){
  const account=await backend.accountsHost.provision(subject);
  const state=JSON.parse(String(await backend.accountStorage.get('accounts'))) as {accounts:Account[]};
  const stored=state.accounts.find(candidate=>candidate.personId===account.personId);
  if(!stored)throw new Error('Fixture account was not persisted');
  if(!stored.passkeys.length)stored.passkeys=[{id:'test',publicKey:[],counter:0}];
  await backend.accountStorage.put('accounts',JSON.stringify(state));

  const identity={subject,clientId,...(signedInAt===undefined?{}:{signedInAt})},current=await backend.passkey(identity,{op:'identity_read'});
  const generation=Number(current?.generation),previous=current?.accountKey?accountKeyRecordSchema.parse(current.accountKey):undefined,key=await generateSigningKey();
  const record={identity:{publicKey:key.publicKey,generation},recoveryWrap};
  const event=await signIdentityEvent(key.privateKey,{personId:account.personId,accountPublicKey:key.publicKey,generation,action:'account-key-set',...(previous?{previousPublicKey:previous.identity.publicKey}:{}),at:Date.now()});
  await backend.passkey(identity,{op:'identity_set',record,event});

  const artifacts=async(value:ConnectionClaim):Promise<{certificate:ConnectionCertificate;event:IdentityEvent}>=>{
    const claim=connectionClaimSchema.parse(value);
    if(claim.personId!==account.personId||claim.accountPublicKey!==key.publicKey||claim.generation!==generation)throw new Error('Fixture refused a connection claim for another account identity');
    return {
      certificate:await signConnection(key.privateKey,claim),
      event:await signIdentityEvent(key.privateKey,{personId:account.personId,generation,accountPublicKey:key.publicKey,connectionId:claim.connectionId,action:'connection-added',at:Date.now()}),
    };
  };

  const connect=async(root:SigningKey,options:{connectionId?:string;agentId?:string;clientId?:string}={}):Promise<ConnectionCertificate>=>{
    const claim:ConnectionClaim={personId:account.personId,...(options.agentId?{agentId:options.agentId}:{}),connectionId:options.connectionId??`connection-${crypto.randomUUID()}`,verificationKey:root.publicKey,generation,accountPublicKey:key.publicKey};
    const {certificate,event}=await artifacts(claim);
    const proof=await signValue(root.privateKey,'wayfinding-connection-request-1',connectionClaim(claim));
    await backend.sealedExecute(subject,'sealed_connection_request',{claim,proof,certificate,event},options.clientId);
    return certificate;
  };

  const device=async(input:{deviceId:string;data:string;agentId?:string;clientId?:string;root?:SigningKey})=>{
    const root=input.root??await generateSigningKey(),credential=await connect(root,{agentId:input.agentId,clientId:input.clientId});
    const body={deviceId:input.deviceId,verificationKey:root.publicKey,data:input.data,credential};
    return {root,credential,registration:{...body,packageSignature:await signPackage(root.privateKey,body)}};
  };

  const detachedDevice=async(input:{deviceId:string;data:string;agentId?:string;root?:SigningKey})=>{
    const root=input.root??await generateSigningKey();
    const claim:ConnectionClaim={personId:account.personId,...(input.agentId?{agentId:input.agentId}:{}),connectionId:`connection-${crypto.randomUUID()}`,verificationKey:root.publicKey,generation,accountPublicKey:key.publicKey};
    const credential=(await artifacts(claim)).certificate,body={deviceId:input.deviceId,verificationKey:root.publicKey,data:input.data,credential};
    return {root,credential,registration:{...body,packageSignature:await signPackage(root.privateKey,body)}};
  };

  return {account,key,identity,record,artifacts,connect,device,detachedDevice};
}

export async function resignDeviceRegistration(root:SigningKey,value:Omit<DeviceRegistration,'packageSignature'>):Promise<DeviceRegistration>{
  return {...value,packageSignature:await signPackage(root.privateKey,value)};
}

/** Add an account certificate and journal event to a real connection request from a trusted test browser. */
export function trustedAccountRemote(remote:SealedRemote,account:Pick<TestAccountIdentity,'artifacts'>):SealedRemote{
  return {
    async listTools(request,options){return remote.listTools(request,options);},
    async callTool(request,options){
      if(request.name!=='sealed_connection_request')return remote.callTool(request,options);
      const args=request.arguments??{},claim=connectionClaimSchema.parse(args.claim),signed=await account.artifacts(claim);
      return remote.callTool({...request,arguments:{...args,...signed}},options);
    },
  };
}
