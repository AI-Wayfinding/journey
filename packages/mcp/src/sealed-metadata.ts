import {Refused} from './commands.ts';
import {itemRule,topicRule,postRule,scalar,cell,sameState,type Snapshot} from './rules.ts';
import type {SealedEnvironment} from './sealed-content.ts';

export interface TopicRegistry { rule:Snapshot; ids:string[]; targets:string[] }
export const emptyTopics=():TopicRegistry=>({rule:topicRule.init(),ids:[],targets:[]});
export const targetKey=(target:Record<string,string>)=>Object.entries(target)[0]!.join(':');
export function changedMetadata(before:Snapshot,after:Snapshot):Snapshot {
 if(sameState(before,after,['allowed','selected']))throw new Refused('Sealed metadata refused by coordination rules');
 return after;
}
export function itemStep(e:SealedEnvironment,before:Snapshot,op:number,extra:Record<string,number>={}):Snapshot {
 return itemRule.step(before,{op,actor:e.person,ownerAgent:0,canRead:+e.can('read'),canWrite:+e.can('artifact.write'),guide:+e.can('board.manage'),newKind:13,newVisibility:scalar(before,'visibility'),newProject:scalar(before,'project'),baseVersion:0,...extra});
}
export function itemReadable(e:SealedEnvironment,rule:Snapshot|undefined):boolean {
 // Existing records without rule state need an explicit migration, never inferred authority.
 return !!rule&&scalar(itemStep(e,rule,5),'allowed')===1;
}
export function topicCreate(e:SealedEnvironment,registry:TopicRegistry,id:string,target:Record<string,string>|undefined,boardOpen:boolean,roundDefault=false):{rule:Snapshot;slot:number} {
 const slot=registry.ids.length;let targetSlot=0;
 if(target){targetSlot=registry.targets.indexOf(targetKey(target));if(targetSlot<0){targetSlot=registry.targets.length;registry.targets.push(targetKey(target));}}
 const before=registry.rule;
 registry.rule=changedMetadata(before,topicRule.step(before,{op:target?1:0,slot,target:targetSlot,actor:e.slot,canTopic:+(roundDefault||e.can(target?'post':'topic.create')),boardOpen:+boardOpen,guide:+e.can('board.manage'),locked:0}));
 registry.ids.push(id);return {rule:registry.rule,slot};
}
export function topicLock(e:SealedEnvironment,registry:TopicRegistry,slot:number,locked:boolean):Snapshot {
 if(!e.can('board.manage')&&!(cell(registry.rule,'Authors',slot)===e.slot&&e.can('topic.create')))throw new Refused('Topic author or guide required');
 registry.rule=topicRule.step(registry.rule,{op:2,slot,target:0,actor:e.slot,canTopic:+e.can('topic.create'),boardOpen:1,guide:+e.can('board.manage'),locked:+locked});
 if(cell(registry.rule,'Locked',slot)!==+locked)throw new Refused('Topic lock refused');return registry.rule;
}
export function postStep(e:SealedEnvironment,before:Snapshot,op:number,topicOpen:boolean,replyTo=0,hidden=false):Snapshot {
 return postRule.step(before,{op,actor:e.slot,actorKind:+!!e.actor.agent,canPost:+e.can('post'),topicOpen:+topicOpen,guide:+e.can('board.manage'),newHidden:+hidden,newReplyTo:replyTo});
}
