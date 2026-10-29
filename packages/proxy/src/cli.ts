#!/usr/bin/env node
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {FileStore} from './file-store.ts';
import {AuthKitProvider,RESOURCE} from './oauth.ts';
import {WayfindingProxy} from './proxy.ts';
import {buildProxyServer} from './server.ts';

const args=process.argv.slice(2);
if(args.includes('--help')){console.error('Usage: node packages/proxy/src/cli.ts [--store DIR] [--port PORT]\nDefault store: ~/.wayfinding; OAuth loopback port: 8717. ts-mls 1.6.4 is unaudited.');process.exit(0);}
let directory=process.env.WAYFINDING_STORE??join(homedir(),'.wayfinding'),port=8717;
for(let i=0;i<args.length;i+=2){const value=args[i+1];if(!value)throw new Error('Missing option value');if(args[i]==='--store')directory=value;else if(args[i]==='--port')port=Number(value);else throw new Error('Unknown CLI option');}
if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid loopback port');
const store=await FileStore.open(directory);
let callback:((params:URLSearchParams)=>void)|undefined;
const listener=createServer((req,res)=>{
 const url=new URL(req.url??'/',`http://127.0.0.1:${port}`);
 if(req.headers.host!==`127.0.0.1:${port}`||url.pathname!=='/callback'||req.method!=='GET'||!callback){res.writeHead(404).end();return;}
 try{provider.validateCallback(url.searchParams);const resolve=callback;callback=undefined;resolve(url.searchParams);res.writeHead(200,{'content-type':'text/plain'}).end('Signed in. Return to your local agent.');}
 catch{res.writeHead(400,{'content-type':'text/plain'}).end('Invalid OAuth callback.');}
});
const provider=await AuthKitProvider.open(store,new URL(`http://127.0.0.1:${port}/callback`),async url=>{console.error(`Sign in to Wayfinding: ${url.href}`);});
const remote=new Client({name:'wayfinding-local-proxy',version:'0.1.0'});
try{
 await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(port,'127.0.0.1',resolve);});
 const receive=()=>new Promise<URLSearchParams>((resolve,reject)=>{
  const timer=setTimeout(()=>{callback=undefined;reject(new Error('OAuth loopback timed out after five minutes'));},300000);
  callback=p=>{clearTimeout(timer);resolve(p);};
 });
 let pending:Promise<URLSearchParams>|undefined;
 // Install callback reception before displaying the authorization URL.
 const initial=provider.redirectToAuthorization.bind(provider);
 provider.redirectToAuthorization=async url=>{pending=receive();await initial(url);};
 if(await provider.authorize()==='REDIRECT'){if(!pending)throw new Error('Missing OAuth redirect');await provider.authorize(fetch,await pending);}
 await remote.connect(new StreamableHTTPClientTransport(RESOURCE,{authProvider:provider}));
 const proxy=await WayfindingProxy.open(remote,store);
 console.error('Wayfinding proxy: ts-mls 1.6.4 is unaudited. Synthetic data only.');
 const handle=await serveStdio(()=>buildProxyServer(proxy));
 let closing=false;
 const close=async()=>{if(closing)return;closing=true;await handle.close();await remote.close();listener.close();await store.close();};
 process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());process.stdin.once('end',()=>void close());
}catch(e){listener.close();await remote.close();await store.close();throw e;}
