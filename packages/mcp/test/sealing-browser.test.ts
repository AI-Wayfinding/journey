import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend } from '../src/backend.ts';
import { parseCommand } from '../src/commands.ts';
import { authenticator } from './console-authenticator.ts';
const identity={subject:'alice',clientId:'https://poc.wayfinding.support/console/client.json'};
async function fixture(){
  let now=Date.now();
  const backend=new MemoryBackend({async get(s){return {name:s,email:`${s}@example.test`};}},()=>now,undefined,true);
  await backend.execute('alice',parseCommand('account_read',{}),identity.clientId);
  const key=await authenticator(),options=await backend.passkey(identity,{op:'begin'});
  await backend.passkey(identity,{op:'finish',credential:key.register(String(options.challenge))});
  const fields={browserId:crypto.randomUUID(),credentialId:key.id,device:{deviceId:`device_${crypto.randomUUID()}`,verificationKey:Buffer.alloc(32,9).toString('base64'),data:'AQ=='}};
  return {backend,key,fields,advance:()=>{now+=300001;}};
}
test('sealing browser enrollment needs exact fresh passkey binding; origin account replay and no UV refused',async()=>{
  const {backend,key,fields,advance}=await fixture();
  const options=await backend.passkey(identity,{op:'browser_begin',...fields});
  const assertion=await key.assert(String(options.challenge));
  const before=backend.snapshot();
  await assert.rejects(backend.passkey(identity,{op:'browser_finish',...fields,device:{...fields.device,data:'Ag=='},assertion}),/Fresh exact/);
  assert.equal(backend.snapshot(),before);
  await assert.rejects(backend.passkey({...identity,subject:'bob'},{op:'browser_finish',...fields,assertion}),/live person/);
  await assert.rejects(backend.passkey(identity,{op:'browser_finish',...fields,assertion:await key.assert(String(options.challenge),1,'https://evil.test')}),/origin/i);
  await assert.rejects(backend.passkey(identity,{op:'browser_finish',...fields,assertion:await key.assert(String(options.challenge),1,undefined,false)}),/verification|verified/i);
  const binding=await backend.passkey(identity,{op:'browser_finish',...fields,assertion});
  assert.equal(binding.deviceId,fields.device.deviceId);
  await assert.rejects(backend.passkey(identity,{op:'browser_finish',...fields,assertion}),/Fresh exact/);
  const list=await backend.passkey(identity,{op:'browser_list'});
  assert.deepEqual(list.browsers,[{id:fields.browserId,credentialId:key.id,devices:[fields.device.deviceId],live:true}]);
  await assert.rejects(backend.passkey(identity,{op:'delete',id:key.id}),/Revoke browser/);
  const second={...fields,device:{...fields.device,deviceId:`device_${crypto.randomUUID()}`}};
  const pending=await backend.passkey(identity,{op:'browser_begin',...second});advance();
  await assert.rejects(backend.passkey(identity,{op:'browser_finish',...second,assertion:await key.assert(String(pending.challenge),2)}),/Fresh exact/);
});
