import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,symlink,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FileStore} from '../src/file-store.ts';

test('proxy: local store excludes concurrent writers, traversal, permissive files and symlinks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wayfinding-store-'));
 const store=await FileStore.open(dir);
 try{
  await assert.rejects(FileStore.open(dir),/locked/);
  await assert.rejects(store.write('../outside','synthetic'),/Unknown/);
  await store.write('state','one');await store.write('state','two');
  assert.equal(await store.read('state'),'two');assert.equal((await stat(join(dir,'state.json'))).mode&0o777,0o600);
  await chmod(join(dir,'state.json'),0o644);await assert.rejects(store.read('state'),/0600/);
  await rm(join(dir,'state.json'));await symlink(join(dir,'lock'),join(dir,'state.json'));await assert.rejects(store.read('state'));
  assert.ok((await readFile(join(dir,'lock'),'utf8')).includes('pid'));
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});
