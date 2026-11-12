import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage.ts';
import { AccountsHost } from '../src/accounts.ts';
import { PartitionedAccountsStorage } from '../src/accounts-storage.ts';
import { tokenHash } from '../src/oauth-store.ts';


class CountStorage extends MemoryStorage {
 reads=0;
 override async get(key:string):Promise<unknown> { this.reads++;return super.get(key); }
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
 const writes=base.writes;
 base.reads=0;
 assert.equal((await host().oauth({op:'verify',token:tokens.tokens.access_token})).kind,'access');
 assert.equal(base.writes,writes);
 assert.equal(base.reads,3,'verification reads only token, account and metadata');
 await host().oauth({op:'revoke',clientId,token:tokens.tokens.access_token});
 assert.equal((await host().oauth({op:'verify',token:tokens.tokens.access_token})).kind,'error');
});

test('accounts: partitioned account and authority writes roll back together',async()=>{
 const base=new MemoryStorage(),store=new PartitionedAccountsStorage(base),host=new AccountsHost(store,profiles);
 const alice=await host.provision('alice'),before=new Map(base.data);
 await assert.rejects(store.transaction(async tx=>{await tx.put('accounts',JSON.stringify({rulesHash:{},accounts:[{...alice,nickname:'bad'}],journeys:[]}));await tx.put('write:authority',JSON.stringify({scopes:[],permits:[]}));throw Error('rollback');}));
 assert.deepEqual(base.data,before);
});
