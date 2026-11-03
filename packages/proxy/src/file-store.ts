import {mkdir,open,lstat,rename,unlink,realpath} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import type {LocalStore} from './store.ts';

/** Exclusive, private, atomic local storage. Stale locks require deliberate operator recovery. */
export class FileStore implements LocalStore {
 private directory:string;
 private lock:FileHandle|undefined;
 private constructor(directory:string,lock:FileHandle){this.directory=directory;this.lock=lock;}
 static async open(directory:string):Promise<FileStore>{
  await mkdir(directory,{recursive:true,mode:0o700});
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw new Error('Store directory must be owned by you and mode 0700');
  const path=await realpath(directory);
  let lock:FileHandle;try{lock=await open(join(path,'lock'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(e){throw new Error('Local store is already locked; do not run two proxies against one store',{cause:e});}
  await lock.writeFile(JSON.stringify({pid:process.pid}));
  return new FileStore(path,lock);
 }
 private path(name:string):string{if(!['state','oauth'].includes(name))throw new Error('Unknown local storage record');return join(this.directory,`${name}.json`);}
 async read(name:string):Promise<string|undefined>{
  if(!this.lock)throw new Error('Store is closed');
  let file:FileHandle;try{file=await open(this.path(name),constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if(e instanceof Error&&'code' in e&&e.code==='ENOENT')return;throw e;}
  try{const info=await file.stat();if(!info.isFile()||(info.mode&0o777)!==0o600||info.uid!==process.getuid?.())throw new Error('Local state must be an owned 0600 regular file');return await file.readFile('utf8');}finally{await file.close();}
 }
 async write(name:string,value:string):Promise<void>{
  if(!this.lock)throw new Error('Store is closed');
  const target=this.path(name),temp=join(this.directory,`.${name}-${crypto.randomUUID()}`);
  const file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(value);await file.sync();}finally{await file.close();}
  try{await rename(temp,target);const dir=await open(this.directory,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}}catch(e){await unlink(temp).catch(()=>{});throw e;}
 }
 async close():Promise<void>{if(this.lock){const lock=this.lock;this.lock=undefined;await lock.close();await unlink(join(this.directory,'lock'));}}
}
