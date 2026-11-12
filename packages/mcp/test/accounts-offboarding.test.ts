import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountsHost, UpstreamUserDeleted, WorkOSProfiles } from '../src/accounts.ts';
import { MemoryStorage } from '../src/storage.ts';
import { tokenHash } from '../src/oauth-store.ts';

test('accounts: refresh suspends reversibly on upstream 404 without consuming credentials',async()=>{
 let failure:Error|undefined,reads=0;
 const host=new AccountsHost(new MemoryStorage(),{get:async()=>{reads++;if(failure)throw failure;return {name:'Alice',email:'alice@example.test'};}});
 await host.provision('alice');const client=await host.oauth({op:'register',client:{client_name:'Test',redirect_uris:['http://127.0.0.1/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}});
 if(client.kind!=='client'||!client.client)throw Error('client');const clientId=client.client.client_id,verifier='a'.repeat(43);
 await host.oauth({op:'request',id:'test',request:{clientId,clientName:'Test',redirectUri:'http://127.0.0.1/callback',challenge:await tokenHash(verifier),expiresAt:Date.now()+600000}});
 const agent=await host.oauth({op:'consent',id:'test',subject:'alice',consent:{name:'Agent',capabilities:['read'],journeys:[]}});if(agent.kind!=='agent')throw Error('agent');
 const code=await host.oauth({op:'code',id:'test',subject:'alice',agentId:agent.agentId});if(code.kind!=='code')throw Error('code');
 const tokens=await host.oauth({op:'exchange',clientId,code:code.code,redirectUri:'http://127.0.0.1/callback',verifier});if(tokens.kind!=='tokens')throw Error('tokens');
 const refresh={op:'refresh' as const,clientId,token:tokens.tokens.refresh_token};
 failure=Error('upstream outage');assert.deepEqual(await host.oauth(refresh),{kind:'error',error:'temporarily_unavailable'});
 failure=undefined;const rotated=await host.oauth(refresh);assert.equal(rotated.kind,'tokens');assert.equal(reads,3);
 if(rotated.kind!=='tokens')throw Error('refresh');failure=new UpstreamUserDeleted();
 assert.deepEqual(await host.oauth({...refresh,token:rotated.tokens.refresh_token}),{kind:'error',error:'invalid_grant'});
 assert.equal((await host.lookup('alice'))!.live,true);
 assert.equal((await host.lookup('alice'))!.suspended,true);
 assert.deepEqual(await host.oauth({op:'verify',token:rotated.tokens.access_token}),{kind:'error',error:'invalid_token'});
 failure=undefined;
 assert.equal((await host.oauth({...refresh,token:rotated.tokens.refresh_token})).kind,'tokens');
 assert.equal((await host.lookup('alice'))!.suspended,undefined);
 assert.equal((await host.oauth({op:'verify',token:rotated.tokens.access_token})).kind,'access');
 await host.removePerson('never-provisioned');await assert.rejects(host.provision('never-provisioned'),/removed/);
});

test('accounts: only a WorkOS 404 is authoritative user deletion',async()=>{
 await assert.rejects(new WorkOSProfiles('synthetic',async()=>new Response(null,{status:404})).get('alice'),UpstreamUserDeleted);
 await assert.rejects(new WorkOSProfiles('synthetic',async()=>new Response(null,{status:503})).get('alice'),error=>!(error instanceof UpstreamUserDeleted));
});
