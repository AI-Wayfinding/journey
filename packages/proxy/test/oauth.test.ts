import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AuthKitProvider,ISSUER,RESOURCE} from '../src/oauth.ts';
import type {LocalStore} from '../src/store.ts';

test('proxy: SDK OAuth DCR, S256 PKCE, state, issuer/resource binding, token exchange and refresh',async()=>{
 const records=new Map<string,string>();const store:LocalStore={async read(n){return records.get(n);},async write(n,v){records.set(n,v);}};
 let redirect:URL|undefined,tokenCalls=0,registered=false,challenge='';
 const provider=await AuthKitProvider.open(store,new URL('http://127.0.0.1:8717/callback'),async url=>{redirect=url;});
 const send:typeof fetch=async(input,init)=>{
  const url=String(input);
  if(url.includes('oauth-protected-resource'))return Response.json({resource:RESOURCE.href,authorization_servers:[ISSUER]});
  if(url.includes('.well-known'))return Response.json({issuer:ISSUER,authorization_endpoint:`${ISSUER}/authorize`,token_endpoint:`${ISSUER}/token`,registration_endpoint:`${ISSUER}/register`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
  if(url===`${ISSUER}/register`){const data=JSON.parse(String(init?.body));assert.equal(data.token_endpoint_auth_method,'none');assert.deepEqual(data.redirect_uris,['http://127.0.0.1:8717/callback']);registered=true;return Response.json({client_id:'synthetic-client',...data});}
  if(url===`${ISSUER}/token`){tokenCalls++;const params=new URLSearchParams(String(init?.body));assert.equal(params.get('resource'),RESOURCE.href);
   if(params.get('grant_type')==='authorization_code'){
    assert.equal(params.get('code'),'synthetic-code');
    const verifier=params.get('code_verifier')!;assert.ok(verifier.length>=43);
    const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');assert.equal(digest,challenge);
   }else{assert.equal(params.get('grant_type'),'refresh_token');assert.equal(params.get('refresh_token'),'synthetic-refresh');}
   return Response.json({access_token:'synthetic-access',token_type:'Bearer',refresh_token:'synthetic-refresh',expires_in:300});
  }
  throw new Error(`Unexpected fake AS request: ${url}`);
 };
 assert.equal(await provider.authorize(send),'REDIRECT');assert.ok(registered);assert.ok(redirect);
 const target=new URL(redirect);assert.equal(target.searchParams.get('code_challenge_method'),'S256');challenge=target.searchParams.get('code_challenge')!;
 const callback=new URLSearchParams({code:'synthetic-code',state:target.searchParams.get('state')!,iss:ISSUER});
 const wrong=new URLSearchParams(callback);wrong.set('state','hostile');await assert.rejects(provider.authorize(send,wrong),/state mismatch/);assert.equal(tokenCalls,0);
 assert.equal(await provider.authorize(send,callback),'AUTHORIZED');assert.equal(provider.tokens()?.access_token,'synthetic-access');
 assert.equal(records.get('oauth')!.includes('synthetic-refresh'),true);
 const restored=await AuthKitProvider.open(store,new URL('http://127.0.0.1:8717/callback'),async()=>{throw new Error('Unexpected redirect');});
 assert.equal(await restored.authorize(send),'AUTHORIZED');assert.equal(tokenCalls,2);
 await assert.rejects(restored.saveDiscoveryState({authorizationServerUrl:'https://evil.test',authorizationServerMetadata:undefined}),/Unexpected OAuth/);
});
