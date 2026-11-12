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

test('journey members show safety numbers, comparison action and verified connection log',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),previousLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
 class Element {children:unknown[]=[];value='';textContent='';constructor(text=''){this.textContent=text;}get childNodes(){return this.children;}append(...children:unknown[]){this.children.push(...children);}replaceChildren(...children:unknown[]){this.children=children;}}
 const work=new Element(),actions=new Map<string,()=>Promise<void>>(),trusted:unknown[][]=[];
 const safety='00001 00002 00003 00004 00005 00006';
 const client={async enrollGroup(){return {admitted:true};},async call(tool:string){if(tool==='agent_list')return {agents:[]};return {members:[{memberId:'alice',name:'Alice',safetyNumber:safety,accountTrust:'changed'}],identities:{alice:{publicKey:'public-key',safetyNumber:safety,accountTrust:'changed'}},identityLog:[{at:1,personId:'alice',action:'connection-added',connectionId:'connection-1',verification:'self-signed',accountTrust:'changed'}]};},async trustAccountKey(...args:unknown[]){trusted.push(args);}};
 const text=(n:Element):string=>n.textContent+' '+n.children.map(c=>typeof c==='string'?c:text(c as Element)).join(' ');
 const fields=(n:Element):Element[]=>[n,...n.children.flatMap(c=>typeof c==='string'?[]:fields(c as Element))];
 Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:()=>null,createElement:()=>new Element(),createTextNode:(s:string)=>new Element(s),querySelector:()=>null}});
 Object.defineProperty(globalThis,'location',{configurable:true,value:{pathname:'/console/journeys/journey-test'}});
 try{
  await renderPrivateWorkspace(client as never,work as never,((parent:Element,label:string,action:()=>Promise<void>)=>{actions.set(label,action);const b=new Element(label);parent.append(b);return b;}) as never);
  assert.match(text(work),/Alice/);assert.match(text(work),new RegExp(safety));assert.match(text(work),/Safety number changed/);assert.match(text(work),/Signed.*changed/);
  const compare=actions.get('Trust compared safety number');assert.ok(compare);await assert.rejects(compare(),/Compare/);
  for(const n of fields(work))if(n.textContent==='')n.value=safety;
  await compare();assert.deepEqual(trusted,[['alice','public-key',safety]]);
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');if(previousLocation)Object.defineProperty(globalThis,'location',previousLocation);else Reflect.deleteProperty(globalThis,'location');}
});
