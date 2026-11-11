import {test} from 'node:test';
import assert from 'node:assert/strict';
import {envelopeBytes,SEALED_FORMAT,SEALED_LIMITS,requireSynthetic,parseSealedRouting} from '../src/sealed-contract.ts';

const valid={groupId:'journey_test',epoch:1,ciphertext:'eA==',contentType:SEALED_FORMAT,size:1};
test('sealed envelope v1 refuses wrong audience epoch byte size format encoding and unallowlisted routing fields',()=>{
 assert.deepEqual(envelopeBytes(valid,'journey_test',1),new Uint8Array([120]));
 assert.throws(()=>envelopeBytes(valid,'other',1),/audience/);
 assert.throws(()=>envelopeBytes(valid,'journey_test',2),/epoch/);
 assert.throws(()=>envelopeBytes({...valid,size:2},'journey_test',1),/size/);
 assert.throws(()=>envelopeBytes({...valid,contentType:'text/plain'},'journey_test',1));
 assert.throws(()=>envelopeBytes({...valid,ciphertext:'eA'},'journey_test',1));
 assert.throws(()=>envelopeBytes({...valid,size:SEALED_LIMITS.envelope+1},'journey_test',1));
 assert.throws(()=>parseSealedRouting('board_create',{name:'clear content'}));
 assert.throws(()=>parseSealedRouting('library_add',{query:'clear search',visibility:'members'}));
 assert.doesNotThrow(()=>requireSynthetic('synthetic'));assert.throws(()=>requireSynthetic('real'),/launch blockers/);
});
