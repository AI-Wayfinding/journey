import {test} from 'node:test';
import assert from 'node:assert/strict';
import {consolePost,consoleRemote} from '../src/remote.ts';
import {sealedRemoteCall} from '../../proxy/src/mode.ts';
import {RemoteFailure} from '../../proxy/src/errors.ts';

// HTTP boundary only: both adapters and error classification run unmodified.
for(const reason of ['Sealed group CAS mismatch','Only own devices or server-ineligible devices may be removed'])test(`browser remote preserves HTTP 409: ${reason}`,async()=>{
 const remote=consoleRemote(consolePost('csrf',async()=>Response.json({error:reason},{status:409})),'browser',async()=>({}));
 const result=await remote.callTool({name:'sealed_group_commit',arguments:{}});
 assert.equal(result.isError,true);assert.deepEqual(result.content,[{type:'text',text:reason}]);
 await assert.rejects(sealedRemoteCall(remote,'sealed_group_commit',{}),(error:unknown)=>error instanceof RemoteFailure&&error.code==='refused');
});

for(const status of [403,500,503])test(`browser remote keeps HTTP ${status} ambiguous`,async()=>{
 const remote=consoleRemote(consolePost('csrf',async()=>Response.json({error:'Sealed group CAS mismatch'},{status})),'browser',async()=>({}));
 await assert.rejects(sealedRemoteCall(remote,'sealed_group_commit',{}),(error:unknown)=>error instanceof RemoteFailure&&error.code==='unavailable');
});
test('browser remote keeps network errors and invalid 409 bodies ambiguous',async()=>{
 for(const send of [async()=>{throw new Error('Network lost')},async()=>new Response('not JSON',{status:409}),async()=>Response.json({error:7},{status:409})]){
  const remote=consoleRemote(consolePost('csrf',send),'browser',async()=>({}));
  await assert.rejects(sealedRemoteCall(remote,'sealed_group_commit',{}),(error:unknown)=>error instanceof RemoteFailure&&error.code==='unavailable');
 }
});
