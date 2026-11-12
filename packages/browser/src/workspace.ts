import * as z from 'zod';
import type {SealedClient} from '../../proxy/src/sealed-client.ts';
const rows=(v:unknown)=>z.array(z.record(z.string(),z.unknown())).parse(v??[]);
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
type Button=(parent:HTMLElement,label:string,action:()=>Promise<void>)=>HTMLButtonElement;
function input(parent:HTMLElement,label:string,value='',multiline=false){const l=el('label',label),n=multiline?el('textarea'):el('input');n.value=value;l.append(n);parent.append(l);return n;}
/** Render decrypted text as text nodes, never HTML, JSON or sealed envelopes. */
function describe(parent:HTMLElement,value:unknown,depth=0):void {
 if(depth>8)return;
 if(value===null||value===undefined)return;
 if(Array.isArray(value)){const list=el('ul');for(const row of value){const item=el('li');describe(item,row,depth+1);if(item.childNodes.length)list.append(item);}parent.append(list);return;}
 if(typeof value==='object'){const list=el('dl');for(const [key,item]of Object.entries(value)){if(['content','sealed','descriptor','privateDefinition','publication','publications','private','contexts','devices','definition','envelope','ciphertext','hash','iv'].includes(key)||/^(?:recordId|groupId|journeyId|deviceId|agentId|personId|.*Revision)$/.test(key))continue;const detail=el('dd');describe(detail,item,depth+1);if(detail.childNodes.length)list.append(el('dt',key),detail);}parent.append(list);return;}
 parent.append(document.createTextNode(String(value)));
}
export async function renderPrivateWorkspace(c:SealedClient,work:HTMLElement,button:Button,isActive:()=>boolean=()=>true):Promise<void>{
 work.replaceChildren();
 const profile=document.getElementById('profile-editor');
 if(profile){const own=await c.call('account_read',{});if(!isActive())return;profile.replaceChildren(el('h2','Your name'));const name=input(profile,'Name',String(own.name??''));button(profile,'Save name',async()=>{if(!name.value.trim())throw new Error('Set your name');await c.call('account_update',{name:name.value.trim()});});}
 const agents=await c.call('agent_list',{});
 if(!isActive())return;
 for(const a of rows(agents.agents)){const row=document.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(String(a.agentId))}"] a`);if(row)row.textContent=String(a.name??a.agentId);}
 const agentRoute=/^\/console\/agents\/([^/]+)$/.exec(location.pathname);
 if(agentRoute){const agentId=decodeURIComponent(agentRoute[1]!),own=rows(agents.agents).find(a=>a.agentId===agentId);if(own){work.append(el('h2','Private connection details'));const name=input(work,'Agent name',String(own.name??'')),app=input(work,'App name',String(own.clientName??''));button(work,'Save connection details',async()=>{await c.call('agent_descriptor_set',{agentId,name:name.value,clientName:app.value});});}return;}
 const route=/^\/console\/journeys\/([^/]+)(?:\/(\w+)(?:\/([^/]+))?)?$/.exec(location.pathname);if(!route)return;
 const journeyId=decodeURIComponent(route[1]!),kind=route[2],item=route[3]?decodeURIComponent(route[3]):undefined;
 const result=el('section');work.append(el('h2','Private workspace'),result);
 const show=async(tool:string,params:Record<string,unknown>)=>{const data=await c.call(tool,params);if(!isActive())return data;result.replaceChildren();describe(result,data);return data;};
 if(kind==='topics'&&item){await show('topic_read',{topicId:item});const text=input(work,'Reply','',true);button(work,'Post reply',async()=>{await c.call('post_create',{topicId:item,body:text.value});text.value='';await show('topic_read',{topicId:item});});return;}
 if(kind==='rounds'&&item){await show('round_read',{roundId:item});return;}
 if(kind==='library'&&item){await show('library_get',{itemId:item});return;}
 const actions=[['Forum','forum_boards'],['Topics','topic_list'],['Library','library_search'],['Rounds','round_list'],['Journey and tasks','journey_read'],['Offers','offer_search']] as const;
 for(const [label,tool]of actions)button(work,label,async()=>{await show(tool,{journeyId});});
 const query=input(work,'Search privately');button(work,'Search library',async()=>{await show('library_search',{journeyId,query:query.value,includeProjects:true});});
 const name=input(work,'Library item name'),text=input(work,'Library item text','',true);button(work,'Add library item',async()=>{await c.call('library_add',{journeyId,name:name.value,kind:'markdown',text:text.value});name.value='';text.value='';await show('library_search',{journeyId});});
 await show('journey_read',{journeyId});
}
