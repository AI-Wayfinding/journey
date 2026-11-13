import type {SealedClient} from '../../proxy/src/sealed-client.ts';
import {agentConsent,type AgentConsent} from '../../mcp/src/oauth-contract.ts';
import * as z from 'zod';
import type {BrowserPost} from './remote.ts';

/** Keep descriptive text local; seal it before issuing the connector's authorization code. */
export class SealedConsent {
 private pending?:{request:string;agentId:string;consent:AgentConsent};
 readonly client:()=>SealedClient|undefined;
 readonly post:BrowserPost;
 readonly confirm:(options:Record<string,unknown>)=>Promise<unknown>;
 constructor(client:()=>SealedClient|undefined,post:BrowserPost,confirm:(options:Record<string,unknown>)=>Promise<unknown>){this.client=client;this.post=post;this.confirm=confirm;}
 async allow(request:string,proposed:AgentConsent):Promise<string>{
  const client=this.client();if(!client)throw new Error('Unlock this browser before allowing the connection');
  const stillUnlocked=()=>{if(this.client()!==client)throw new Error('Connection locked; unlock this browser and try again');};
  if(this.pending&&this.pending.request!==request)throw new Error('Finish the pending connection first');
  if(!this.pending){
   const consent=agentConsent.parse(proposed);
   const wire={request,name:'MCP client',capabilities:consent.capabilities,journeys:consent.journeys};
   const assertion=consent.capabilities.includes('device.keys')?await this.confirm(await this.post('/oauth/consent/options',{...wire,decision:'allow'})):undefined;
   stillUnlocked();
   const prepared=await this.post('/oauth/consent',{...wire,decision:'prepare',...(assertion?{assertion}:{})});
   this.pending={request,agentId:z.string().min(1).parse(prepared.agentId),consent};
  }
  stillUnlocked();
  const {agentId,consent}=this.pending;
  const agents=z.array(z.object({agentId:z.string(),clientName:z.string().optional()})).parse((await client.call('agent_list')).agents);
  const clientName=agents.find(a=>a.agentId===agentId)?.clientName;
  await client.call('agent_descriptor_set',{agentId,name:consent.name,...(clientName!==undefined?{clientName}:{})});
  stillUnlocked();
  const result=await this.post('/oauth/consent',{request,decision:'finish'});
  return z.string().url().parse(result.redirect);
 }
}
