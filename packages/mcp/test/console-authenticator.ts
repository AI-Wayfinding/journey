import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64 = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const bytes = (value: string) => new TextEncoder().encode(value);
const hash = async (value: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', value));
export async function authenticator() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const id = crypto.getRandomValues(new Uint8Array(32));
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
  const rpHash = await hash(bytes('poc.wayfinding.support'));
  const clientData = (type: string, challenge: string, origin = 'https://poc.wayfinding.support') => bytes(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64(id),
    register(challenge: string, origin?: string) {
      const length = new Uint8Array([0, id.length]);
      const data = Buffer.concat([rpHash, new Uint8Array([0x45, 0, 0, 0, 0]), new Uint8Array(16), length, id, cose]);
      const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, string>>([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]]));
      return { id: b64(id), rawId: b64(id), type: 'public-key' as const, clientExtensionResults: {}, response: { clientDataJSON: b64(clientData('webauthn.create', challenge, origin)), attestationObject: b64(attestation), transports: ['internal'] } };
    },
    async assert(challenge: string, count = 1, origin?: string) {
      const data = Buffer.concat([rpHash, new Uint8Array([5, 0, 0, 0, count])]);
      const client = clientData('webauthn.get', challenge, origin);
      const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.concat([data, await hash(client)])));
      // WebAuthn ES256 signatures are DER, while Web Crypto produces r || s.
      const integer = (part: Uint8Array) => { let n = Buffer.from(part); while (n.length > 1 && n[0] === 0) n = n.subarray(1); if (n[0]! & 0x80) n = Buffer.concat([Buffer.from([0]), n]); return Buffer.concat([Buffer.from([2, n.length]), n]); };
      const pair = Buffer.concat([integer(signature.slice(0, 32)), integer(signature.slice(32))]);
      return { id: b64(id), rawId: b64(id), type: 'public-key' as const, clientExtensionResults: {}, response: { clientDataJSON: b64(client), authenticatorData: b64(data), signature: b64(Buffer.concat([Buffer.from([0x30, pair.length]), pair])) } };
    },
  };
}
