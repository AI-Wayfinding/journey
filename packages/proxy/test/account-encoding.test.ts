import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateSigningKey,publicKeySchema,safetyNumber,signValue} from '../../shared/account-identity.ts';
import {decode,json} from '../src/codec.ts';

test('account public keys reject noncanonical encodings of identical Ed25519 key material',async()=>{
 const key=await generateSigningKey(),alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',last=alphabet.indexOf(key.publicKey.at(-2)!);
 const alias=key.publicKey.slice(0,-2)+alphabet[last|1]+'=';
 assert.notEqual(alias,key.publicKey);assert.deepEqual(decode(alias),decode(key.publicKey));
 const imported=await crypto.subtle.importKey('raw',decode(alias),'Ed25519',false,['verify']),signature=await signValue(key.privateKey,'encoding-test',{});
 assert.equal(await crypto.subtle.verify('Ed25519',imported,decode(signature),json(['encoding-test',{}])),true);
 assert.equal(publicKeySchema.safeParse(alias).success,false);
 await assert.rejects(safetyNumber(alias),/canonical/i);
 assert.equal(publicKeySchema.parse(key.publicKey),key.publicKey);
});
