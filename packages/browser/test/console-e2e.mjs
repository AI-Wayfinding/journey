// Run: node packages/browser/test/console-e2e.mjs ws://127.0.0.1:PORT/devtools/page/TARGET
// Optional: --wrangler http://127.0.0.1:8787 (already signed-in staging browser tab).
// Optional: --no-prf exercises code-only creation and unlock (fresh browser profile).
// No remote Worker is contacted: every request to the application origin is fulfilled locally.
import assert from 'node:assert/strict';
import {MemoryBackend} from '../../mcp/src/backend.ts';
import {createConsole} from '../../mcp/src/console/index.ts';
import {ConsoleSessions,SESSION_COOKIE} from '../../mcp/src/console/session.ts';
import {createVerifier} from '../../mcp/src/auth.ts';
import {createLocalJWKSet} from 'jose';
import {keyPair,ISSUER,RESOURCE} from '../../mcp/test/helpers.ts';
const ws=new WebSocket(process.argv[2]);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const pending=new Map(),errors=[],requests=[];
const call=(method,params={})=>new Promise((r,j)=>{pending.set(++id,{r,j});ws.send(JSON.stringify({id,method,params}));});
const origin=RESOURCE.origin,secret='synthetic-browser-e2e-secret-at-least-32-bytes',backend=new MemoryBackend({async get(s){return {name:s,email:`${s}@example.test`};}},Date.now,undefined,true),signer=await keyPair('browser-e2e');
const target=createConsole({backend,secret,resource:RESOURCE,issuer:ISSUER,verifier:createVerifier({issuer:ISSUER,resource:RESOURCE,getKey:createLocalJWKSet(signer.jwks)})});
const cookie=(await new ConsoleSessions(backend,secret,origin,Date.now).create(SESSION_COOKIE,{kind:'session',subject:'alice',clientId:origin+'/console/client.json',csrf:'browser-e2e-csrf',signedInAt:Date.now(),expiresAt:Date.now()+3600000})).split(';')[0];
const local=process.argv.includes('--wrangler')?new URL(process.argv[process.argv.indexOf('--wrangler')+1]):undefined;
if(local&&!['127.0.0.1','localhost','[::1]'].includes(local.hostname))throw new Error('Only local wrangler accepted');
async function intercept(p){
 try{
  const request=p.request;requests.push(request.postData??'');const headers=new Headers(request.headers);if(!local)headers.set('cookie',cookie);const init={method:request.method,headers,...(request.postData?{body:request.postData}:{})};
  const response=local?await fetch(new URL(new URL(request.url).pathname+new URL(request.url).search,local),{...init,redirect:'manual'}):await target.fetch(new Request(request.url,init));
  const responseHeaders=[...response.headers].filter(([name])=>name!=='set-cookie').map(([name,value])=>({name,value}));for(const value of response.headers.getSetCookie())responseHeaders.push({name:'set-cookie',value});
  await call('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:response.status,responseHeaders,body:Buffer.from(await response.arrayBuffer()).toString('base64')});
 }catch(error){errors.push(String(error));await call('Fetch.failRequest',{requestId:p.requestId,errorReason:'Failed'});}
}
let loaded;
const nextLoad=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Page load timed out')),20000);loaded=()=>{clearTimeout(timer);resolve();};});
ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.j(new Error(JSON.stringify(m.error))):p.r(m.result);}else if(m.method==='Page.loadEventFired'){loaded?.();loaded=undefined;}else if(m.method==='Fetch.requestPaused')void intercept(m.params);else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text+' '+(m.params.exceptionDetails.exception?.description??''));else if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')errors.push(m.params.entry.text);};
const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Missing or disabled button '+${JSON.stringify(label)});b.click();})()`);
const wait=condition=>evaluate(`new Promise((resolve,reject)=>{const ready=()=>{if(${condition}){clearTimeout(timer);observer.disconnect();resolve(true);}};const observer=new MutationObserver(ready),timer=setTimeout(()=>{observer.disconnect();reject(Error('UI wait timed out: '+document.body.innerText));},20000);observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});ready();})`);
const fill=(label,value)=>evaluate(`(()=>{const e=[...document.querySelectorAll('label')].find(e=>e.firstChild.textContent===${JSON.stringify(label)})?.querySelector('input,textarea');if(!e)throw Error('Missing field '+${JSON.stringify(label)});e.value=${JSON.stringify(value)};})()`);
const noPrf=process.argv.includes('--no-prf');
const unlock=async code=>{if(noPrf){await fill('Recovery code',code);await click('Unlock with recovery code');}else await click('Unlock with passkey');};
const deadline=setTimeout(()=>{console.error('Browser proof exceeded deadline');process.exit(1);},120000);
let auth;
try{
 await call('Page.enable');await call('Runtime.enable');await call('Log.enable');await call('Fetch.enable',{patterns:[{urlPattern:origin+'/*'}]});await call('WebAuthn.enable');auth=await call('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:!noPrf}});
 await call('Storage.clearDataForOrigin',{origin,storageTypes:'indexeddb,local_storage'});
 const initialLoad=nextLoad();await call('Page.navigate',{url:origin+'/console'});await initialLoad;await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Create passkey and trust this browser')");
 assert.match(await evaluate('document.body.innerText'),/Set your name/);
 await click('Create passkey and trust this browser');await wait("document.body.innerText.includes('Set your name before continuing')");
 const marker='REAL-BROWSER-PRIVATE-CANARY<img src=x onerror=window.__xss=1>';await fill('Your name',marker);await click('Create passkey and trust this browser');await wait("document.querySelector('#connection-controls code')||document.querySelector('code')");
 const code=await evaluate("document.querySelector('code').textContent");assert.match(code,/^[A-F0-9-]+$/);
 await fill('Retype your saved recovery code','F'.repeat(64));await click('I saved my recovery code — continue');await wait("document.querySelector('[role=status]').textContent.includes('Retype')");assert.equal(await evaluate('location.pathname'),'/console/onboarding');
 await fill('Retype your saved recovery code',code);const done=nextLoad();await click('I saved my recovery code — continue');await done;await wait("document.body.innerText.includes('Your connections')");
 assert.equal(await evaluate("document.body.innerText.includes('Private browser device')||document.body.innerText.includes('Agents\\n')"),false);
 // Inspect only ciphertext metadata. PRF support must match the stored wrapper.
 assert.equal(await evaluate("new Promise((resolve,reject)=>{const r=indexedDB.open('wayfinding-browser-v1');r.onsuccess=()=>{const db=r.result,q=db.transaction('vaults').objectStore('vaults').getAll();q.onsuccess=()=>{resolve(!!q.result[0]?.prfWrap);db.close();};q.onerror=reject;};r.onerror=reject;})"),!noPrf);
 const profileLoad=nextLoad();await call('Page.navigate',{url:origin+'/console/profile'});await profileLoad;await wait("document.body.innerText.includes('Unlock with passkey')");
 await unlock(code);await wait("document.querySelector('#profile-editor input')");assert.equal(await evaluate("document.querySelector('#profile-editor input').value"),marker);assert.equal(await evaluate("document.querySelector('#profile-editor img')===null&&window.__xss!==1"),true);
 assert.equal(await evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('wayfinding-browser-v1');r.onsuccess=()=>{const db=r.result,q=db.transaction('vaults').objectStore('vaults').getAll();q.onsuccess=()=>{const json=JSON.stringify(q.result);resolve(!json.includes(${JSON.stringify(marker)})&&!json.includes(${JSON.stringify(code)}));db.close();};q.onerror=reject;};r.onerror=reject;})`),true);
 await click('Lock this connection');await wait("document.body.innerText.includes('Unlock with recovery code')");assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(marker)})`),false);
 await fill('Recovery code','F'.repeat(64));await click('Unlock with recovery code');await wait("!document.querySelector('#profile-editor input')&&document.querySelector('[role=status]').textContent!=='Locked. Private keys and decrypted content were removed from this page.'");
 await fill('Recovery code',code);await click('Unlock with recovery code');await wait("document.querySelector('#profile-editor input')");assert.equal(await evaluate("document.querySelector('#profile-editor input').value"),marker);
 for(const text of requests)assert.equal(text.includes(marker),false,'network canary');if(!local)assert.equal(backend.snapshot().includes(marker),false,'server storage canary');assert.deepEqual(errors,[],'browser exceptions / CSP errors');
 // Stall a vault encryption, then simulate leaving while its durable commit is in flight.
 await evaluate(`(()=>{const original=crypto.subtle.encrypt.bind(crypto.subtle);let started;window.__vaultWriteStarted=new Promise(r=>started=r);crypto.subtle.encrypt=(algorithm,key,data)=>{if(algorithm.additionalData&&new TextDecoder().decode(algorithm.additionalData).startsWith('["wayfinding-browser-vault-1"')){crypto.subtle.encrypt=original;started();return new Promise((resolve,reject)=>{window.__resumeVaultWrite=()=>original(algorithm,key,data).then(resolve,reject);});}return original(algorithm,key,data);};})()`);
 await fill('Name','LOCK-RACE-SYNTHETIC');await click('Save name');await evaluate('window.__vaultWriteStarted');
 assert.equal(await evaluate(`(async()=>{window.dispatchEvent(new Event('pagehide'));const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('wayfinding-browser-v1');r.onsuccess=()=>resolve(r.result);r.onerror=reject;});const record=await new Promise((resolve,reject)=>{const r=db.transaction('vaults').objectStore('vaults').getAll();r.onsuccess=()=>resolve(r.result[0]);r.onerror=reject;});db.close();window.__writerKey=JSON.stringify([location.origin,record.context.personId]);return navigator.locks.request(window.__writerKey,{ifAvailable:true},lock=>!!lock);})()`),false,'pagehide retains writer fence until pending commit drains');
 await evaluate('window.__resumeVaultWrite()');await evaluate(`Promise.race([navigator.locks.request(window.__writerKey,()=>true),new Promise((_,reject)=>setTimeout(()=>reject(Error('Writer lock did not drain')),5000))])`);
 assert.equal(await evaluate("document.querySelector('#profile-editor input')===null"),true,'pagehide scrub remains intact after commit');assert.deepEqual(errors,[]);
 console.log(`PASS: real browser ${noPrf?'recovery-only fallback':'PRF'} onboarding, name required, saved-code confirmation, unified connections, encrypted IndexedDB, inert markup, lock/write race, wrong/right recovery, CSP and network canary`);
}finally{clearTimeout(deadline);if(auth)await call('WebAuthn.removeVirtualAuthenticator',auth);await call('Fetch.disable');ws.close();}
