import { SignJWT, jwtVerify } from 'jose';
import { base64url } from '../agents.ts';
import { Refused } from '../commands.ts';
import type { ConsoleBackend, ConsoleRecord } from './contract.ts';

export const SESSION_COOKIE = '__Host-wayfinding-console';
export const OAUTH_COOKIE = '__Host-wayfinding-oauth';
export const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export const cookie = (name: string, value: string, age: number) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
export class ConsoleSessions {
  private readonly key: Uint8Array;
  private readonly backend: ConsoleBackend;
  private readonly origin: string;
  private readonly now: () => number;
  constructor(backend: ConsoleBackend, secret: string, origin: string, now: () => number) {
    this.key = new TextEncoder().encode(secret); this.backend = backend; this.origin = origin; this.now = now;
  }
  async create(name: string, record: ConsoleRecord): Promise<string> {
    const id = random();
    await this.backend.consoleRecord({ op: 'put', id, record });
    const signed = await new SignJWT({ purpose: name }).setProtectedHeader({ alg: 'HS256' }).setIssuer(this.origin).setAudience('console')
      .setJti(id).setIssuedAt(Math.floor(this.now() / 1000)).setExpirationTime(Math.floor(record.expiresAt / 1000)).sign(this.key);
    return cookie(name, signed, Math.floor((record.expiresAt - this.now()) / 1000));
  }
  async read(request: Request, name: string, op: 'read' | 'take' | 'delete' = 'read'): Promise<ConsoleRecord | undefined> {
    const values = (request.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
    if (values.length !== 1) return undefined;
    try {
      const { payload } = await jwtVerify(values[0]!.slice(name.length + 1), this.key, { algorithms: ['HS256'], issuer: this.origin, audience: 'console', currentDate: new Date(this.now()), requiredClaims: ['exp', 'iat', 'jti'] });
      if (payload.purpose !== name || typeof payload.jti !== 'string') return undefined;
      const record = await this.backend.consoleRecord({ op, id: payload.jti });
      return record && record.expiresAt > this.now() ? record : undefined;
    } catch { return undefined; }
  }
  async require(request: Request) {
    const record = await this.read(request, SESSION_COOKIE);
    if (record?.kind !== 'session') throw new Refused('Sign in to the console');
    await this.backend.execute(record.subject, { tool: 'account_read', input: {} }, record.clientId);
    return record;
  }
}
