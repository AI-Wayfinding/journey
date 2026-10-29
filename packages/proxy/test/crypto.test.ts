import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contentKey,encrypt,decrypt} from '../src/crypto.ts';
import {utf8,text,decode,encode} from '../src/codec.ts';
test('proxy: AES-GCM binds ciphertext to group, artifact and version and rejects tampering',async()=>{
 const key=contentKey(), data=await encrypt(utf8.encode('synthetic-marker'),key,'g','a',1);
 assert.equal(text.decode(await decrypt(data,key,'g','a',1)),'synthetic-marker');
 for(const [g,a,v] of [['other','a',1],['g','other',1],['g','a',2]] as const) await assert.rejects(decrypt(data,key,g,a,v));
 const changed=decode(data); changed[15]=changed[15]!^1;
 await assert.rejects(decrypt(encode(changed),key,'g','a',1));
 await assert.rejects(decrypt(data,contentKey(),'g','a',1));
 assert.notEqual(data,await encrypt(utf8.encode('synthetic-marker'),key,'g','a',1));
});
