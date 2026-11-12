import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPrivateWorkspace} from '../src/workspace.ts';

test('locking during private profile read never repaints decrypted content',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 const previousLocation=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{configurable:true,value:{pathname:'/console/profile'}});
 class Element {children:unknown[]=[];value='';textContent='';append(...children:unknown[]){this.children.push(...children);}replaceChildren(...children:unknown[]){this.children=children;}}
 const profile=new Element(),work=new Element();let active=true;
 let resolve!:(v:Record<string,unknown>)=>void;
 const pending=new Promise<Record<string,unknown>>(r=>{resolve=r;});
 Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:()=>profile,createElement:()=>new Element()}});
 try{
  const rendering=renderPrivateWorkspace({call:()=>pending} as never,work as never,(()=>new Element()) as never,()=>active);
  active=false;profile.replaceChildren('LOCKED');work.replaceChildren();resolve({name:'PRIVATE-NAME'});await rendering;
  assert.deepEqual(profile.children,['LOCKED']);assert.deepEqual(work.children,[]);
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');if(previousLocation)Object.defineProperty(globalThis,'location',previousLocation);else Reflect.deleteProperty(globalThis,'location');}
});
