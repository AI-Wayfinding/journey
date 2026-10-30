import { localhostAllowedHostnames } from '@modelcontextprotocol/server';
import { createVerifier } from './auth.ts';
import { createApp } from './app.ts';
import { durableBackend, type ObjectBindings } from './objects.ts';
export { Journey, Accounts } from './objects.ts';

export interface Env extends ObjectBindings {
  AUTHKIT_ISSUER: string;
  MCP_RESOURCE: string;
  AUTHKIT_AUTHORIZE_URL: string;
  CONSOLE_SECRET?: string;
}

let cached: { env: Env; app: ReturnType<typeof createApp> } | undefined;
function appFor(env: Env): ReturnType<typeof createApp> {
  if (cached?.env !== env) {
    const resource = new URL(env.MCP_RESOURCE);
    const backend = durableBackend(env);
    cached = { env, app: createApp({
      verifier: createVerifier({ issuer: env.AUTHKIT_ISSUER, resource }), resource, issuer: env.AUTHKIT_ISSUER,
      allowedHosts: [resource.hostname, ...localhostAllowedHostnames()], backend,
      signinUrl: env.AUTHKIT_AUTHORIZE_URL,
      ...(env.CONSOLE_SECRET ? { console: { secret: env.CONSOLE_SECRET, backend } } : {}),
    }) };
  }
  return cached.app;
}
export default {
  fetch(request: Request, env: Env): Promise<Response> { return appFor(env).fetch(request); },
};
