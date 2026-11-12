import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountsHost } from '../src/accounts.ts';
import { MemoryStorage } from '../src/storage.ts';
import { authenticator } from './console-authenticator.ts';

const identity = {subject:'alice',clientId:'https://poc.wayfinding.support/console/client.json'};
async function fixture() {
 const storage=new MemoryStorage(); let now=Date.now();
 const host=()=>new AccountsHost(storage,{async get(){return {name:'Alice',email:'alice@example.test'};}},undefined,undefined,()=>now,true);
 await host().provision('alice');
 const key=await authenticator(),options=await host().passkey(identity,{op:'begin'});
 await host().passkey(identity,{op:'finish',credential:key.register(String(options.challenge))});
 return {host,key,advance:(ms:number)=>{now+=ms;},now:()=>now};
}
test('F6: console sign-in alone cannot add a second passkey',async()=>{
 const f=await fixture();
 await assert.rejects(f.host().passkey(identity,{op:'begin'}),/existing passkey|recovery code/i);
});

test('F6: existing UV assertion authorizes one addition, not a replay',async()=>{
 const f=await fixture(),options=await f.host().passkey(identity,{op:'addition_options'}),assertion=await f.key.assert(String(options.challenge));
 const next=await f.host().passkey(identity,{op:'begin',assertion});
 const second=await authenticator();
 await f.host().passkey(identity,{op:'finish',credential:second.register(String(next.challenge))});
 assert.equal(((await f.host().passkey(identity,{op:'list'})).passkeys as unknown[]).length,2);
 await assert.rejects(f.host().passkey(identity,{op:'begin',assertion}));
});
test('recovery: removes all connections immediately; persistent 72h clock cannot be restarted or cancelled',async()=>{
 const f=await fixture(),before=await f.host().lookup('alice');
 const start=await f.host().passkey(identity,{op:'recovery_start'});
 assert.equal(start.readyAt,f.now()+259200000);
 assert.deepEqual((await f.host().passkey(identity,{op:'list'})).passkeys,[]);
 await assert.rejects(f.host().passkey(identity,{op:'begin'}),/72|recovery/i);
 f.advance(259199999);
 await assert.rejects(f.host().passkey(identity,{op:'begin'}),/72|recovery/i);
 assert.equal((await f.host().passkey(identity,{op:'recovery_start'})).readyAt,start.readyAt);
 await assert.rejects(f.host().passkey(identity,{op:'recovery_cancel'} as never));
 f.advance(1);
 assert.ok((await f.host().passkey(identity,{op:'begin'})).challenge);
 assert.equal((await f.host().lookup('alice'))!.personId,before!.personId);
});

test('recovery: agent cannot start recovery; tokens and bindings are dead immediately',async()=>{
 const f=await fixture(),host=f.host(),clientId='agent-client',verifier='a'.repeat(43);
 const {tokenHash}=await import('../src/oauth-store.ts');
 await host.oauth({op:'request',id:'request',request:{clientId,clientName:'MCP client',redirectUri:'http://127.0.0.1/callback',challenge:await tokenHash(verifier),expiresAt:f.now()+600000}});
 const agent=await host.oauth({op:'consent',id:'request',subject:'alice',consent:{name:'MCP client',capabilities:['read'],journeys:[]}});assert.equal(agent.kind,'agent');if(agent.kind!=='agent')return;
 const code=await host.oauth({op:'code',id:'request',subject:'alice',agentId:agent.agentId});if(code.kind!=='code')throw Error('code');
 const tokens=await host.oauth({op:'exchange',clientId,code:code.code,redirectUri:'http://127.0.0.1/callback',verifier});if(tokens.kind!=='tokens')throw Error('tokens');
 await assert.rejects(host.passkey({subject:'alice',clientId},{op:'recovery_start'}),/person|live/i);
 await host.passkey(identity,{op:'recovery_start'});
 assert.equal((await host.oauth({op:'verify',token:tokens.tokens.access_token})).kind,'error');
 assert.equal((await host.oauth({op:'refresh',clientId,token:tokens.tokens.refresh_token})).kind,'error');
 await assert.rejects(host.passkey({subject:'alice',clientId},{op:'recovery_cancel'} as never));
 await assert.rejects(host.passkey({subject:'alice',clientId},{op:'recovery_start'}),/person|live/i);
 await host.oauth({op:'request',id:'new-request',request:{clientId,clientName:'MCP client',redirectUri:'http://127.0.0.1/callback',challenge:await tokenHash(verifier),expiresAt:f.now()+600000}});
 await assert.rejects(host.oauth({op:'consent',id:'new-request',subject:'alice',consent:{name:'MCP client',capabilities:['read'],journeys:[]}}),/recovery/i);
});

test('F6: deleting the last passkey cannot turn email sign-in back into enrollment authority',async()=>{
 const f=await fixture();await assert.rejects(f.host().passkey(identity,{op:'delete',id:f.key.id}),/last passkey|recovery/i);
 await assert.rejects(f.host().passkey(identity,{op:'begin'}),/existing passkey|recovery code/i);
});
