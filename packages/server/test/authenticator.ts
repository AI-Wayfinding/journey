import { base64url, unbase64url } from '../src/crypto.js';
const text = (s: string) => new TextEncoder().encode(s);
function join(...parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((n,p) => n+p.length,0)); let i=0; for(const p of parts) {out.set(p,i);i+=p.length;} return out; }
function cbor(value: unknown): Uint8Array {
  const head = (major: number, n: number) => n < 24 ? new Uint8Array([major * 32 + n]) : n < 256 ? new Uint8Array([major * 32 + 24, n]) : new Uint8Array([major * 32 + 25, n >> 8, n & 255]);
  if (typeof value === 'number') return value >= 0 ? head(0,value) : head(1,-1-value);
  if (typeof value === 'string') return join(head(3,text(value).length),text(value));
  if (value instanceof Uint8Array) return join(head(2,value.length),value);
  if (value && typeof value === 'object') { const entries = Object.entries(value); return join(head(5,entries.length),...entries.flatMap(([k,v]) => [cbor(Number.isNaN(Number(k)) ? k : Number(k)),cbor(v)])); }
  throw new Error('bad cbor test data');
}
function der(raw: Uint8Array): Uint8Array {
  const part = (x: Uint8Array) => { let i=0; while (i<x.length-1 && x[i] === 0) i++; let v=new Uint8Array(x.slice(i)); if(v[0]! & 128) v=new Uint8Array(join(new Uint8Array([0]),v)); return join(new Uint8Array([2,v.length]),v); };
  const a=part(raw.slice(0,32)),b=part(raw.slice(32)); return join(new Uint8Array([0x30,a.length+b.length]),a,b);
}
export async function authenticator(rpId = 'app.wayfinding.support', origin = 'https://app.wayfinding.support') {
  const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const jwk = await crypto.subtle.exportKey('jwk',pair.publicKey);
  const id = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256',text(rpId)));
  const counter = (n:number) => new Uint8Array([0,0,0,n]);
  const clientData = (challenge:string,type:string) => base64url(text(JSON.stringify({type,challenge,origin})));
  return {
    register(challenge:string, prf = true) {
      const cose = cbor({1:2,3:-7,'-1':1,'-2':unbase64url(jwk.x!),'-3':unbase64url(jwk.y!)});
      const raw = unbase64url(id);
      const authData = join(rpHash,new Uint8Array([0x45]),counter(0),new Uint8Array(16),new Uint8Array([raw.length >> 8,raw.length & 255]),raw,cose);
      return {id,rawId:id,type:'public-key',response:{clientDataJSON:clientData(challenge,'webauthn.create'),attestationObject:base64url(cbor({fmt:'none',authData,attStmt:{}})),transports:[]},clientExtensionResults:{prf:{enabled:prf}}};
    },
    async login(challenge:string,n=1) {
      const clientDataJSON = clientData(challenge,'webauthn.get');
      const authData = join(rpHash,new Uint8Array([0x05]),counter(n));
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(unbase64url(clientDataJSON))));
      const sig = new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new Uint8Array(join(authData,hash))));
      return {id,rawId:id,type:'public-key',response:{clientDataJSON,authenticatorData:base64url(authData),signature:base64url(der(sig)),userHandle:null},clientExtensionResults:{}};
    },
  };
}
