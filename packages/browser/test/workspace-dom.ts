/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import assert from 'node:assert/strict';
import {renderPrivateWorkspace} from '../src/workspace.ts';
import type {SealedClient} from '../../proxy/src/sealed-client.ts';

class Element {
 children:Element[]=[];value='';ownText='';
 constructor(text=''){this.ownText=text;}
 get childNodes(){return this.children;}
 get textContent():string{return this.ownText+this.children.map(c=>c.textContent).join(' ');}
 set textContent(text:string){this.ownText=text;}
 append(...children:Element[]){this.children.push(...children);}
 replaceChildren(...children:Element[]){this.ownText='';this.children=children;}
}
/** A DOM boundary stand-in; calls still use the real sealed browser transport. */
export function workspaceDom(pathname:string){
 const previous=['document','location','CSS'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)] as const);
 Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:()=>null,querySelector:()=>null,createElement:()=>new Element(),createTextNode:(s:string)=>new Element(s)}});
 Object.defineProperty(globalThis,'location',{configurable:true,value:{pathname}});
 Object.defineProperty(globalThis,'CSS',{configurable:true,value:{escape:(s:string)=>s}});
 const work=new Element(),actions=new Map<string,()=>Promise<void>>();
 return {
  work,
  async render(c:SealedClient){actions.clear();await renderPrivateWorkspace(c,work as unknown as HTMLElement,(parent,label,action)=>{actions.set(label,action);const b=new Element(label);(parent as unknown as Element).append(b);return b as unknown as HTMLButtonElement;});},
  async click(label:string){const action=actions.get(label);assert.ok(action,`Missing browser control: ${label}`);await action();},
  input(label:string,value:string){const visit=(e:Element):Element|undefined=>e.ownText===label?e:e.children.map(visit).find(Boolean);const field=visit(work)?.children[0];assert.ok(field,`Missing input: ${label}`);field.value=value;},
  restore(){for(const [key,descriptor] of previous)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);},
 };
}
