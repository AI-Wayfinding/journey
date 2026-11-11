import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,symlink,readFile,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FileStore} from '../src/file-store.ts';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

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

test('proxy: FileStore accepts every literal store record used by proxy and browser sources',async()=>{
 const names=new Set<string>();
 for(const root of [new URL('../src/',import.meta.url),new URL('../../browser/src/',import.meta.url)]){
  const directory=fileURLToPath(root);
  for(const entry of await readdir(directory,{recursive:true})){
   if(!entry.endsWith('.ts'))continue;
   const path=join(directory,entry),source=ts.createSourceFile(path,await readFile(path,'utf8'),ts.ScriptTarget.Latest,true);
   const visit=(node:ts.Node):void=>{
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)){
     const method=node.expression,receiver=method.expression;
     // LocalStore calls use store or this.store; do not confuse SealedClient.write with storage.
     const isStore=ts.isIdentifier(receiver)&&receiver.text==='store'||ts.isPropertyAccessExpression(receiver)&&receiver.name.text==='store';
     if(isStore&&['read','write'].includes(method.name.text)){
      const name=node.arguments[0];
      assert.ok(name&&ts.isStringLiteral(name),`${path}: store record names must be literals for this guard`);
      names.add(name.text);
     }
    }
    ts.forEachChild(node,visit);
   };
   visit(source);
  }
 }
 // A vacuous scan is not evidence, and these three persisted formats must stay covered.
 for(const expected of ['state','oauth','sealed-state'])assert.ok(names.has(expected),`source scan missed ${expected}`);
 const dir=await mkdtemp(join(tmpdir(),'wayfinding-record-guard-')),store=await FileStore.open(dir);
 try{
  for(const name of names){
   assert.equal(await store.read(name),undefined);
   await store.write(name,'first');await store.write(name,'latest');
   assert.equal(await store.read(name),'latest');
   assert.equal((await stat(join(dir,`${name}.json`))).mode&0o777,0o600);
  }
  for(const name of ['unknown','../outside','sealed-state/../oauth']){
   await assert.rejects(store.read(name),/Unknown local storage record/);
   await assert.rejects(store.write(name,'forbidden'),/Unknown local storage record/);
  }
 }finally{await store.close();await rm(dir,{recursive:true,force:true});}
});
