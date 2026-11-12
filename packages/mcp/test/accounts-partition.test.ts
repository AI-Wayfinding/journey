import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage.ts';
import { AccountsHost } from '../src/accounts.ts';
import { PartitionedAccountsStorage } from '../src/accounts-storage.ts';
import { tokenHash } from '../src/oauth-store.ts';


class CountStorage extends MemoryStorage {
 reads=0;
 readKeys:string[]=[];
 override async get(key:string):Promise<unknown> { this.reads++;this.readKeys.push(key);return super.get(key); }
}
const profiles = { get: async (subject:string) => ({name:subject,email:`${subject}@example.test`}) };
const callback='http://127.0.0.1:1234/callback', verifier='a'.repeat(43);
test('accounts: partitioned state isolates accounts and tokens; verification is read-only after eviction',async()=>{
 const base=new CountStorage(),store=new PartitionedAccountsStorage(base),host=()=>new AccountsHost(store,profiles);
 const alice=await host().provision('alice'),bob=await host().provision('bob');
 assert.equal(await base.get('accounts'),undefined);
 const bobBefore=await base.get(`accounts:account:${bob.personId}`);
 const beforeUpdate=base.writes;
 await host().update(alice.personId,'New label');
 assert.equal(await base.get(`accounts:account:${bob.personId}`),bobBefore);
 assert.equal(base.writes-beforeUpdate,1,'updating one account does not rewrite peer rows or indexes');
 const client=await host().oauth({op:'register',client:{client_name:'Test',redirect_uris:[callback],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}});
 if(client.kind!=='client'||!client.client)throw Error('client');const clientId=client.client.client_id,id='test';
 await host().oauth({op:'request',id,request:{clientId,clientName:'Test',redirectUri:callback,challenge:await tokenHash(verifier),expiresAt:Date.now()+600000}});
 const agent=await host().oauth({op:'consent',id,subject:'alice',consent:{name:'Agent',capabilities:['read'],journeys:[]}});if(agent.kind!=='agent')throw Error('agent');
 const code=await host().oauth({op:'code',id,subject:'alice',agentId:agent.agentId});if(code.kind!=='code')throw Error('code');
 const tokens=await host().oauth({op:'exchange',clientId,code:code.code,redirectUri:callback,verifier});if(tokens.kind!=='tokens')throw Error('tokens');
 const hash=await tokenHash(tokens.tokens.access_token);
 assert.ok(await base.get(`accounts:access:${hash}`));
 assert.equal((await host().oauth({op:'verify',token:tokens.tokens.access_token})).kind,'access'); // first hourly activity touch
 const writes=base.writes;
 base.reads=0;
 assert.equal((await host().oauth({op:'verify',token:tokens.tokens.access_token})).kind,'access');
 assert.equal(base.writes,writes);
 assert.equal(base.reads,3,'verification reads only token, account and metadata');
 await host().oauth({op:'revoke',clientId,token:tokens.tokens.access_token});
 assert.equal(base.data.has(`accounts:access:${hash}`),false,'Revocation deletes the row key, not a null tombstone');
 assert.equal(base.data.has(`accounts:refresh:${await tokenHash(tokens.tokens.refresh_token)}`),false);
 assert.equal((await host().oauth({op:'verify',token:tokens.tokens.access_token})).kind,'error');
});

test('accounts: partitioned account and authority writes roll back together',async()=>{
 const base=new MemoryStorage(),store=new PartitionedAccountsStorage(base),host=new AccountsHost(store,profiles);
 const alice=await host.provision('alice'),before=new Map(base.data);
 await assert.rejects(store.transaction(async tx=>{await tx.put('accounts',JSON.stringify({rulesHash:{},accounts:[{...alice,nickname:'bad'}],journeys:[]}));await tx.put('write:authority',JSON.stringify({scopes:[],permits:[]}));throw Error('rollback');}));
 assert.deepEqual(base.data,before);
});

test('accounts: anonymous rows never join assembled state or ordinary account writes',async()=>{
 const base=new CountStorage(),store=new PartitionedAccountsStorage(base),host=new AccountsHost(store,profiles);
 const alice=await host.provision('alice');
 const metadata={client_name:'Test',redirect_uris:[callback],token_endpoint_auth_method:'none' as const,grant_types:['authorization_code' as const],response_types:['code' as const]};
 const client=await host.oauth({op:'register',client:metadata});if(client.kind!=='client'||!client.client)throw Error('client');
 await host.oauth({op:'request',id:'pending',request:{clientId:client.client.client_id,clientName:'Test',redirectUri:callback,challenge:await tokenHash(verifier),expiresAt:Date.now()+600000}});
 const assembled=JSON.parse(String(await store.get('accounts')));
 assert.deepEqual(assembled.oauth.clients,[]);
 assert.deepEqual(assembled.oauth.requests,[]);
 assert.equal(await base.get('accounts:clients:index'),undefined);
 assert.equal(await base.get('accounts:requests:index'),undefined);
 base.reads=0; base.readKeys=[];
 await host.update(alice.personId,'updated');
 assert.ok(base.reads<30,'account writes must not read anonymous rows');
 assert.deepEqual(base.readKeys.filter(key=>/^(oauth-anonymous:|accounts:(clients|requests):)/.test(key)),[],'account writes never scan anonymous indexes or rows');
 base.reads=0;
 assert.equal((await host.oauth({op:'client',clientId:client.client.client_id})).kind,'client');
 assert.ok(base.reads<=2,'client lookup is keyed');
});

test('accounts: anonymous capacity refuses only new register and authorize; expiry reclaims capacity',async()=>{
 let now=1_800_000_000_000;
 const base=new MemoryStorage(),host=new AccountsHost(new PartitionedAccountsStorage(base),profiles,undefined,undefined,()=>now);
 const alice=await host.provision('alice');
 const metadata={client_name:'Test',redirect_uris:[callback],token_endpoint_auth_method:'none' as const,grant_types:['authorization_code' as const],response_types:['code' as const]};
 const register=()=>host.oauth({op:'register',client:metadata});
 const first=await register();if(first.kind!=='client'||!first.client)throw Error('client');const clientId=first.client.client_id;
 const request={clientId,clientName:'Test',redirectUri:callback,challenge:await tokenHash(verifier),expiresAt:now+600000};
 await host.oauth({op:'request',id:'consent',request});
 const agent=await host.oauth({op:'consent',id:'consent',subject:'alice',consent:{name:'Agent',capabilities:['read'],journeys:[]}});if(agent.kind!=='agent')throw Error('agent');
 const code=await host.oauth({op:'code',id:'consent',subject:'alice',agentId:agent.agentId});if(code.kind!=='code')throw Error('code');
 const tokens=await host.oauth({op:'exchange',clientId,code:code.code,redirectUri:callback,verifier});if(tokens.kind!=='tokens')throw Error('tokens');
 for(let n=1;n<8192;n++)await register();
 await assert.rejects(register(),/Anonymous OAuth capacity reached/);
 for(let n=0;n<8192;n++)await host.oauth({op:'request',id:`pending-${n}`,request});
 await assert.rejects(host.oauth({op:'request',id:'overflow',request}),/Anonymous OAuth capacity reached/);
 await host.update(alice.personId,'still writable');
 assert.equal((await host.provision('bob')).live,true);
 assert.equal((await host.oauth({op:'verify',token:tokens.tokens.access_token})).kind,'access');
 assert.equal((await host.oauth({op:'refresh',clientId,token:tokens.tokens.refresh_token})).kind,'tokens');
 assert.equal((await host.oauth({op:'request',id:'pending-0'})).kind,'request');
 await host.oauth({op:'deny',id:'pending-0'});
 for(const [key,value] of base.data)if(key.startsWith('oauth-anonymous:'))assert.ok(Buffer.byteLength(value)<128*1024,`${key} must fit a DO value`);
 now+=600001;
 assert.equal((await register()).kind,'client');
 const pinned=await host.oauth({op:'client',clientId});assert.equal(pinned.kind==='client'&&pinned.client?.client_id,clientId,'authorized client survives its registration TTL');
 assert.equal((await host.oauth({op:'request',id:'new',request:{...request,expiresAt:now+600000}})).kind,'request');
});
