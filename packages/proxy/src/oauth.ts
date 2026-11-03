import {auth,type OAuthClientProvider,type OAuthClientMetadata,type StoredOAuthClientInformation,type StoredOAuthTokens,type OAuthDiscoveryState} from '@modelcontextprotocol/client';
import * as z from 'zod';
import type {LocalStore} from './store.ts';
export const ISSUER='https://welcoming-folk-53-staging.authkit.app';
export const RESOURCE=new URL('https://poc.wayfinding.support/mcp');
const tokenSchema=z.object({access_token:z.string(),token_type:z.string(),refresh_token:z.string().optional(),expires_in:z.number().optional(),scope:z.string().optional(),issuer:z.literal(ISSUER).optional()});
const clientSchema=z.object({client_id:z.string(),client_secret:z.string().optional(),client_id_issued_at:z.number().optional(),client_secret_expires_at:z.number().optional(),issuer:z.literal(ISSUER).optional()});
const savedSchema=z.object({tokens:tokenSchema.optional(),client:clientSchema.optional(),verifier:z.string().optional()}).strict();

/** SDK performs discovery, DCR, S256 PKCE, refresh and code exchange; host validates callback state. */
export class AuthKitProvider implements OAuthClientProvider {
 readonly redirectUrl:URL;
 readonly clientMetadata:OAuthClientMetadata;
 private store:LocalStore;
 private saved:z.infer<typeof savedSchema>={};
 private discovery:OAuthDiscoveryState|undefined;
 private nonce:string=crypto.randomUUID();
 private redirect:(url:URL)=>Promise<void>;
 private constructor(store:LocalStore,redirectUrl:URL,redirect:(url:URL)=>Promise<void>){
  this.store=store;this.redirectUrl=redirectUrl;this.redirect=redirect;
  this.clientMetadata={client_name:'Wayfinding local proxy',redirect_uris:[redirectUrl.href],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'};
 }
 static async open(store:LocalStore,redirectUrl:URL,redirect:(url:URL)=>Promise<void>):Promise<AuthKitProvider>{
  if(redirectUrl.hostname!=='127.0.0.1'||redirectUrl.protocol!=='http:')throw new Error('OAuth requires an IPv4 loopback redirect');
  const p=new AuthKitProvider(store,redirectUrl,redirect),raw=await store.read('oauth');if(raw)p.saved=savedSchema.parse(JSON.parse(raw));return p;
 }
 private persist(){return this.store.write('oauth',JSON.stringify(this.saved));}
 state(){return this.nonce;}
 validateCallback(params:URLSearchParams):string{
  if(params.get('state')!==this.nonce)throw new Error('OAuth state mismatch');
  if(params.has('error'))throw new Error('OAuth authorization refused');
  const code=params.get('code');if(!code)throw new Error('Missing OAuth code');return code;
 }
 clientInformation(){return this.saved.client;}
 async saveClientInformation(c:StoredOAuthClientInformation){this.saved.client=clientSchema.parse(c);await this.persist();}
 tokens(){return this.saved.tokens;}
 async saveTokens(t:StoredOAuthTokens){this.saved.tokens=tokenSchema.parse(t);await this.persist();}
 async saveCodeVerifier(verifier:string){this.saved.verifier=verifier;await this.persist();}
 codeVerifier(){if(!this.saved.verifier)throw new Error('Missing PKCE verifier');return this.saved.verifier;}
 async redirectToAuthorization(url:URL){if(url.origin!==new URL(ISSUER).origin)throw new Error('Unexpected authorization server');await this.redirect(url);}
 async saveDiscoveryState(s:OAuthDiscoveryState){if(s.authorizationServerUrl!==ISSUER||s.authorizationServerMetadata?.issuer!==ISSUER||s.resourceMetadata?.resource!==RESOURCE.href)throw new Error('Unexpected OAuth issuer or resource');this.discovery=s;}
 discoveryState(){return this.discovery;}
 async invalidateCredentials(scope:'all'|'client'|'tokens'|'verifier'|'discovery'){
  if(scope==='all')this.saved={};if(scope==='client')delete this.saved.client;if(scope==='tokens')delete this.saved.tokens;if(scope==='verifier')delete this.saved.verifier;if(scope==='discovery')this.discovery=undefined;await this.persist();
 }
 async authorize(fetchFn:typeof fetch=fetch,callback?:URLSearchParams){
  const result=await auth(this,{serverUrl:RESOURCE,fetchFn,...(callback?{authorizationCode:this.validateCallback(callback),iss:callback.get('iss')??undefined}:{})});
  if(result==='AUTHORIZED'){delete this.saved.verifier;this.nonce=crypto.randomUUID();await this.persist();}return result;
 }
}
