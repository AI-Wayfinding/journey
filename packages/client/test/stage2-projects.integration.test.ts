import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { newId } from '@ai-wayfinding/core';
import { localServer, person, journey, connected, state, mcp, command, failedCommand, tool, failedTool, projectChange, createProject, change, refresh, addPerson, addExpiringPerson, faultProxy, scratch, control, request, as } from './stage2-fixtures.js';
localServer();

it('real CLI and stdio MCP expose empty projects, inherited participation and read-only D17 without content elevation', async () => {
  const owner = await person(), trip = await journey(owner), adding = await addPerson(trip, owner), writer = await connected(adding, trip), reader = await connected(adding, trip, 'read');
  const wf = await state(writer), rf = await state(reader), sdk = await mcp(rf), transport = await faultProxy(), tracked = await state(reader, transport.origin), monitored = await mcp(tracked);
  try {
    const p = await command(wf, 'project', 'create', '--purpose', '  Work together 🧭  ');
    expect(p).toMatchObject({ purpose: 'Work together 🧭', state: 'getting-started', creator: writer.session.principal, participants: [], participation: [] });
    expect(p.history).toHaveLength(1); expect((await tool(sdk, 'project_list'))[0]).toEqual(p);
    await failedTool(sdk, 'project_purpose', 'denied', { id: p.id, purpose: 'Nonparticipant', predecessor: p.revision });
    await failedCommand(rf, 'denied', 'project', 'state', p.id, '--project-state', 'active', '--predecessor', String(p.revision));
    const before = await readFile(rf);
    const cliJoined = await command(tracked, 'project', 'join', p.id);
    expect(cliJoined.participants.sort()).toEqual([adding.principal, writer.session.principal, reader.session.principal].sort());
    expect((await tool(monitored, 'project_leave', { id: p.id })).participants).toEqual([]);
    expect((await tool(monitored, 'project_join', { id: p.id })).participation[0]).toMatchObject({ member: adding.principal, active: true });
    const left = await command(tracked, 'project', 'leave', p.id);
    expect(left.participants).toEqual([]);
    expect(transport.requests.filter(r => r.method === 'POST')).toHaveLength(4);
    await projectChange(trip, adding, 'project.join', { project: p.id, member: adding.principal, predecessor: left.participation[0].revision });
    const joined = await tool(sdk, 'project_show', { id: p.id });
    expect(joined.participants.sort()).toEqual([adding.principal, writer.session.principal, reader.session.principal].sort());
    const newcomer = await connected(adding, trip, 'read'), nf = await state(newcomer), nsdk = await mcp(nf);
    try {
      expect((await command(nf, 'project', 'show', p.id)).participants).toContain(newcomer.session.principal);
      await change(trip, owner, 'member.renew', { id: newcomer.session.principal, expiresAt: new Date(Date.now() + 1000).toISOString() });
      await new Promise(resolve => setTimeout(resolve, 1200));
      await failedCommand(nf, 'Access to this journey has ended', 'project', 'show', p.id);
      await failedTool(nsdk, 'project_show', 'Access to this journey has ended', { id: p.id });
      expect((await tool(sdk, 'project_show', { id: p.id })).participants).not.toContain(newcomer.session.principal);
    } finally { await nsdk.close(); newcomer.close(); }
    const edited = await tool(sdk, 'project_purpose', { id: p.id, purpose: 'Read-only participant metadata', predecessor: p.revision, member: newId(), actor: owner.principal, grants: ['members.manage'], project: newId() });
    expect(edited.purpose).toBe('Read-only participant metadata'); expect(edited.history.at(-1).actor).toBe(reader.session.principal);
    for (const field of ['grants','actor','member','project']) expect(edited).not.toHaveProperty(field);
    await failedCommand(rf, 'conflict', 'project', 'purpose', p.id, '--purpose', 'Stale', '--predecessor', String(p.revision));
    await failedTool(sdk, 'project_state', 'conflict', { id: p.id, state: 'active', predecessor: p.revision });
    await failedTool(sdk, 'project_state', 'Supply the observed', { id: p.id, state: 'active' });
    await failedCommand(rf, 'Supply --predecessor', 'project', 'purpose', p.id, '--purpose', 'No observed revision');
    const archived = await command(rf, 'project', 'state', p.id, '--project-state', 'archived', '--predecessor', String(edited.revision));
    expect(archived.state).toBe('archived'); expect(await tool(sdk, 'project_show', { id: p.id })).toEqual(archived);
    const reopened = await tool(sdk, 'project_state', { id: p.id, state: 'looking-for-others', predecessor: archived.revision });
    expect(reopened.state).toBe('looking-for-others'); expect(reopened.history.at(-1)).toMatchObject({ from: 'archived', to: 'looking-for-others' });
    const item = await command(wf, 'add', '--type', 'document', '--title', 'Not D17', '--body', 'Content');
    await change(trip, owner, 'member.role', { member: adding.principal, role: 'read-only' });
    const readsStart = transport.requests.length;
    await failedCommand(rf, 'denied', 'project', 'create', '--purpose', 'No creation');
    await failedTool(sdk, 'project_create', 'denied', { purpose: 'No creation' });
    const bytes = join(scratch, 'readonly.bin'); await writeFile(bytes, 'Must not stage');
    for (const args of [ ['add','--type','document','--title','No','--body','No'], ['add','--type','file','--title','No','--file',bytes], ['comment',item.id,'No'], ['edit',item.id,'--predecessor',item.version,'--type','document','--title','No','--body','No'], ['delete',item.id] ]) await failedCommand(tracked, 'read-only', ...args);
    for (const [name,args] of [ ['add',{ type:'file',title:'No',files:[{path:bytes}] }], ['comment',{id:item.id,text:'No'}], ['edit',{id:item.id,predecessor:item.version,type:'document',title:'No',body:'No'}], ['delete',{id:item.id}] ] as const) await failedTool(monitored, name, 'read-only', args);
    await failedTool(monitored, 'artifact_project', 'denied', { id:item.id,project:p.id,predecessor:null });
    await failedCommand(tracked, 'denied', 'artifact', 'project', item.id, p.id, '--predecessor', 'null');
    expect(transport.requests.slice(readsStart).every(r => r.method === 'GET')).toBe(true);
    expect(await readFile(rf)).toEqual(before);
    await refresh(trip, owner); expect(JSON.stringify(trip.entries.map(row => row.proof))).not.toContain('Read-only participant metadata');
    expect(trip.entries.filter(row => ['project.join','project.leave'].includes(row.proof.type))).toHaveLength(5);
    await projectChange(trip, adding, 'project.leave', { project:p.id,member:adding.principal,predecessor:reopened.participation[0].revision });
    expect((await tool(sdk,'project_show',{id:p.id})).participants).toEqual([]);
    await failedCommand(rf,'denied','project','purpose',p.id,'--purpose','After leave','--predecessor',String(reopened.revision));
    await failedTool(sdk,'project_state','denied',{id:p.id,state:'active',predecessor:reopened.revision});
  } finally { await sdk.close(); await monitored.close(); await transport.close(); writer.close(); reader.close(); }
}, 120_000);

it('CLI/MCP placement is single-project content authority with observed history and consistent intersected selectors', async () => {
  const owner = await person(), trip = await journey(owner), agent = await connected(owner,trip), file = await state(agent), sdk = await mcp(file);
  try {
    const p = await tool(sdk,'project_create',{purpose:'First grouping'}), q = await command(file,'project','create','--purpose','Second grouping');
    const main = await command(file,'add','--type','document','--title','Shared main','--body','Needle','--tags','keep');
    const attachment = join(scratch, 'project-attachment.txt'); await writeFile(attachment, 'Project attachment bytes');
    const item = await tool(sdk,'add',{type:'prompt',title:'Shared placed',body:'Needle',tags:['keep'],files:[{path:attachment}]});
    expect(item).toMatchObject({project:null,placementRevision:null,placementHistory:[]});
    const placed = await command(file,'artifact','project',item.id,p.id,'--predecessor','null');
    expect(placed).toMatchObject({project:p.id,author:item.author,version:item.version}); expect(placed.placementHistory).toHaveLength(1);
    expect(await command(file,'list')).toEqual([main]); expect(await tool(sdk,'list',{project:'main'})).toEqual([main]);
    expect((await command(file,'list','--project','all')).map((v:{id:string})=>v.id).sort()).toEqual([main.id,item.id].sort());
    expect(await tool(sdk,'list',{project:p.id,type:'prompt',tag:'keep'})).toEqual([placed]);
    expect(await command(file,'search','Needle','--project',p.id,'--type','prompt','--tag','keep')).toEqual([placed]);
    expect(await tool(sdk,'search',{text:'Needle',project:p.id,type:'document'})).toEqual([]);
    expect(await tool(sdk,'search',{text:'Needle',project:'main',tag:'keep'})).toEqual([main]);
    expect(await command(file,'list','--project',q.id)).toEqual([]);
    await failedCommand(file,'Unknown project','list','--project',newId());
    await failedTool(sdk,'search','project must be text',{text:'Needle',project:[]});
    await failedTool(sdk,'artifact_project','Supply the observed',{id:item.id,project:q.id});
    await failedCommand(file, 'Invalid project selector', 'list', '--project', 'not-a-project');
    await failedTool(sdk, 'list', 'Unknown project', { project: newId() });
    await failedTool(sdk, 'artifact_project', 'project must be text', { id: item.id, project: [p.id, q.id], predecessor: placed.placementRevision });
    await failedCommand(file, 'Supply --predecessor', 'artifact', 'project', item.id, q.id, '--predecessor', '-1');
    await failedTool(sdk, 'artifact_project', 'Supply the observed', { id: item.id, project: q.id, predecessor: '0' });
    await failedTool(sdk,'artifact_project','conflict',{id:item.id,project:q.id,predecessor:null});
    await failedCommand(file,'conflict','artifact','project',item.id,newId(),'--predecessor',String(placed.placementRevision));
    const moved = await tool(sdk,'artifact_project',{id:item.id,project:q.id,predecessor:placed.placementRevision,author:newId(),actor:owner.principal,grants:['members.manage'],projects:[p.id,q.id]});
    expect(moved).toMatchObject({project:q.id,version:item.version,author:item.author}); expect(moved.placementHistory.at(-1)).toMatchObject({from:p.id,to:q.id,actor:agent.session.principal});
    expect((await command(file,'show',item.id)).versions).toHaveLength(1);
    await projectChange(trip,owner,'project.join',{project:q.id,member:owner.principal,predecessor:null});
    const archived = await tool(sdk,'project_state',{id:q.id,state:'archived',predecessor:q.revision});
    expect((await command(file,'show',item.id)).item).toEqual(moved); expect(await tool(sdk,'list',{project:q.id})).toEqual([moved]);
    const outside = await addPerson(trip, owner), nonparticipant = await connected(outside, trip, 'read'), readState = await state(nonparticipant), readSdk = await mcp(readState);
    try {
      // No independent agent participation and placement cannot restrict direct reads.
      expect((await tool(readSdk, 'project_show', { id: q.id })).participants).not.toContain(nonparticipant.session.principal);
      expect((await tool(readSdk, 'show', { id: item.id })).item).toEqual(moved);
      expect(await command(readState, 'versions', item.id)).toHaveLength(1);
      const comment = await tool(sdk, 'comment', { id: item.id, text: 'Archived comment' });
      expect(await command(readState, 'comments', item.id)).toEqual([comment]);
      const output = join(scratch, 'project-download.txt');
      await tool(readSdk, 'download', { id: item.id, blob: item.payload.attachments[0].blob.id, path: output });
      expect(await readFile(output, 'utf8')).toBe('Project attachment bytes');
    } finally { await readSdk.close(); nonparticipant.close(); }
    const cleared = await command(file,'artifact','project',item.id,'none','--predecessor',String(moved.placementRevision));
    expect(cleared.project).toBeNull(); expect(cleared.placementHistory).toHaveLength(3);
    expect((await tool(sdk,'list')).map((v:{id:string})=>v.id).sort()).toEqual([main.id,item.id].sort());
    const restored = await tool(sdk,'artifact_project',{id:item.id,project:q.id,predecessor:cleared.placementRevision});
    expect(restored.project).toBe(q.id); // Archive is a readable label, not a content-write freeze.
    expect((await tool(sdk,'project_state',{id:q.id,state:'active',predecessor:archived.revision})).state).toBe('active');
    await tool(sdk,'delete',{id:item.id});
    await failedCommand(file,'No journey artifact','artifact','project',item.id,p.id,'--predecessor',String(cleared.placementRevision));
    expect((await command(file,'list','--project','all')).map((v:{id:string})=>v.id)).toEqual([main.id]);
    await refresh(trip,owner); expect(trip.entries.filter(row=>row.proof.type==='artifact.project')).toHaveLength(4);
    for (const row of trip.entries.filter(row=>row.proof.type==='artifact.project')) expect(Object.keys(row.proof.body).sort()).toEqual(['actor','artifact','author','format','predecessor','project']);
  } finally { await sdk.close(); agent.close(); }
}, 90_000);

it('current adding-person downgrade preserves participant metadata and legacy scope never limits restored writes', async () => {
  const owner=await person(),trip=await journey(owner),adding=await addPerson(trip,owner),writer=await connected(adding,trip),reader=await connected(adding,trip,'read');
  const wf=await state(writer),rf=await state(reader),sdk=await mcp(wf),p=await createProject(trip,owner);
  try {
    await projectChange(trip,adding,'project.join',{project:p.id,member:adding.principal,predecessor:null});
    for (const role of ['read-only','read-write'] as const) {
      await change(trip,owner,'member.role',{member:adding.principal,role});
      const view=await command(wf,'project','show',p.id);
      const updated=await tool(sdk,'project_purpose',{id:p.id,purpose:'Metadata '+role,predecessor:view.revision});
      expect(updated.participants.sort()).toEqual([adding.principal,writer.session.principal,reader.session.principal].sort());
      expect((await command(wf,'status')).scope).toBe(role==='read-only'?'read':'readwrite');
      if (role === 'read-only') await failedCommand(rf,'denied','project','create','--purpose','Downgraded');
      else expect((await command(rf,'project','create','--purpose','Restored legacy reader')).purpose).toBe('Restored legacy reader');
      if(role==='read-only') { await failedTool(sdk,'project_create','denied',{purpose:'Downgraded'}); await failedCommand(wf,'read-only','add','--type','document','--title','No','--body','No'); }
    }
    await change(trip,owner,'member.remove',{member:adding.principal});
    await failedCommand(wf,'Access to this journey has ended','project','show',p.id);
    await failedTool(sdk,'project_purpose','Access to this journey has ended',{id:p.id,purpose:'Removed',predecessor:p.revision});
  } finally { await sdk.close();writer.close();reader.close(); }
}, 90_000);

it('adding-person expiry ends inherited participation and metadata authority for still-approved agents', async () => {
  const owner = await person(), trip = await journey(owner), p = await createProject(trip, owner);
  const expiresAt = Date.now() + 5000, adding = await addExpiringPerson(trip, owner, expiresAt);
  const agent = await connected(adding, trip, 'read'), file = await state(agent), sdk = await mcp(file);
  try {
    await projectChange(trip, adding, 'project.join', { project: p.id, member: adding.principal, predecessor: null });
    const edited = await tool(sdk, 'project_purpose', { id: p.id, purpose: 'Before person expiry', predecessor: p.revision });
    expect(edited.participants.sort()).toEqual([adding.principal, agent.session.principal].sort());
    const before = await readFile(file);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt - Date.now()) + 100));
    await failedCommand(file, 'Access to this journey has ended', 'project', 'state', p.id, '--project-state', 'active', '--predecessor', String(edited.revision));
    await failedTool(sdk, 'project_purpose', 'Access to this journey has ended', { id: p.id, purpose: 'After person expiry', predecessor: edited.revision });
    expect(await readFile(file)).toEqual(before);
    await refresh(trip, owner);
    expect(trip.entries.at(-1)!.proof.seq).toBe(edited.revision);
    const observer = await connected(owner, trip), observerFile = await state(observer);
    try { expect((await command(observerFile, 'project', 'show', p.id)).participants).toEqual([]); }
    finally { observer.close(); }
  } finally { await sdk.close(); agent.close(); }
}, 60_000);
it('unsupported capability, signed future minimum and unknown actions fail without partial project output or credential changes',async()=>{
  const owner=await person(),trip=await journey(owner),agent=await connected(owner,trip),p=await createProject(trip,owner);
  const missing=await faultProxy({omitCapability:true}),unknown=await faultProxy({response:text=>{const body=JSON.parse(text);body.log.at(-1).proof.type='project.future';return JSON.stringify(body);}});
  const good=await state(agent),mf=await state(agent,missing.origin),uf=await state(agent,unknown.origin),sdk=await mcp(uf);
  try {
    const before=await readFile(good);
    await failedCommand(mf,'Update the client','project','list');
    await failedCommand(uf,'Update the client','project','show',p.id);
    await failedTool(sdk,'project_list','Update the client');
    const future=await control(trip,owner,'client.minVersion',{version:'0.1.8'});
    expect((await request(`/v1/journeys/${trip.id}/log`,'POST',{control:future},{...as(owner),'X-Client-Version':'0.1.8'})).status).toBe(201);
    await failedCommand(good,'Update the client','project','list');
    await failedTool(sdk,'project_show','Update the client',{id:p.id});
    expect(await readFile(good)).toEqual(before); expect(missing.requests.every(r=>r.method==='GET')).toBe(true); expect(unknown.requests.every(r=>r.method==='GET')).toBe(true);
  } finally {await sdk.close();await missing.close();await unknown.close();agent.close();}
},60_000);

it('a real commit race rereads after stale metadata and placement rather than overwriting another signed change',async()=>{
  const owner=await person(),trip=await journey(owner),agent=await connected(owner,trip),p=await createProject(trip,owner);
  await projectChange(trip,owner,'project.join',{project:p.id,member:owner.principal,predecessor:null});
  let race: (() => Promise<void>) | undefined = async () => { await projectChange(trip, owner, 'project.state', { project: p.id, state: 'active', predecessor: p.revision }); };
  const transport = await faultProxy({ beforePost: async () => { const pending = race; race = undefined; await pending?.(); } }), file = await state(agent, transport.origin), sdk = await mcp(file);
  try {
    await failedCommand(file,'conflict','project','purpose',p.id,'--purpose','Must not overwrite','--predecessor',String(p.revision));
    const latest=await tool(sdk,'project_show',{id:p.id});expect(latest.purpose).toBe(p.purpose);expect(latest.state).toBe('active');
    expect((await tool(sdk,'project_purpose',{id:p.id,purpose:'Reread then commit',predecessor:latest.revision})).purpose).toBe('Reread then commit');
    const item=await command(file,'add','--type','document','--title','Placement','--body','Stable');
    race = async () => { await projectChange(trip, owner, 'artifact.project', { artifact: item.id, author: item.author, actor: owner.principal, project: p.id, predecessor: null }); };
    await failedTool(sdk, 'artifact_project', 'conflict', { id: item.id, project: p.id, predecessor: null });
    const first = (await tool(sdk, 'show', { id: item.id })).item;
    expect(first.project).toBe(p.id); expect(first.placementHistory).toHaveLength(1);
    expect(first.placementHistory[0].actor).toBe(owner.principal);
    await failedCommand(file,'conflict','artifact','project',item.id,'none','--predecessor','null');
    expect((await command(file,'artifact','project',item.id,'none','--predecessor',String(first.placementRevision))).project).toBeNull();
  } finally {await sdk.close();await transport.close();agent.close();}
},60_000);

it('pending rotation blocks creation and placement but not authorized inherited-participant metadata',async()=>{
  const owner=await person(),trip=await journey(owner),agent=await connected(owner,trip),guest=await addPerson(trip,owner),p=await createProject(trip,owner),file=await state(agent),sdk=await mcp(file);
  try {
    const item=await command(file,'add','--type','document','--title','Before rotation','--body','Body');
    await projectChange(trip,owner,'project.join',{project:p.id,member:owner.principal,predecessor:null});
    await change(trip,owner,'member.remove',{member:guest.principal});
    const updated=await tool(sdk,'project_purpose',{id:p.id,purpose:'Metadata during rotation',predecessor:p.revision});
    expect(updated.purpose).toBe('Metadata during rotation');
    await failedCommand(file,'denied','project','create','--purpose','Blocked');
    await failedTool(sdk,'artifact_project','denied',{id:item.id,project:p.id,predecessor:null});
    await failedCommand(file,'read-only','comment',item.id,'Blocked');
    expect((await tool(sdk,'show',{id:item.id})).item.project).toBeNull();
  } finally {await sdk.close();agent.close();}
},60_000);
