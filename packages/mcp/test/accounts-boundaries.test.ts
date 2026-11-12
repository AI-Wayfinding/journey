import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountsHost } from '../src/accounts.ts';
import { MemoryStorage } from '../src/storage.ts';
import { durableBackend } from '../src/objects.ts';
import { MemoryBlobs } from '../src/relay.ts';

test('accounts: unknown journeys are refused before allocating a Durable Object',async()=>{
 const host=new AccountsHost(new MemoryStorage(),{get:async()=>({name:'Alice',email:'alice@example.test'})});let allocations=0;
 const backend=durableBackend({WORKOS_API_KEY:'synthetic',BLOBS:new MemoryBlobs(),
  ACCOUNTS:{getByName(){return {async fetch(request:Request){const body=await request.json() as {action:string;subject:string;personId:string;clientId:string};
   const value=body.action==='provision'?await host.provision(body.subject):body.action==='resolveActor'?await host.resolveActor(body.personId,body.clientId):body.action==='directory'?await host.directory():undefined;
   return Response.json({value});}};}},
  JOURNEYS:{getByName(){allocations++;return {async fetch(){return Response.json({value:{}});}};}}});
 await assert.rejects(backend.inbox('alice','journey_unknown'),/Unknown journey/);
 assert.equal(allocations,0);
});
