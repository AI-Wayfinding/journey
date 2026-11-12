import { localhostAllowedHostnames } from '@modelcontextprotocol/server';
import { createVerifier } from './auth.ts';
import { createApp } from './app.ts';
import { durableBackend, type ObjectBindings } from './objects.ts';
// Earlier prototype classes were deleted by the reset migration; journeys start empty in JourneyResetV1.
export { Journey as JourneyResetV1 } from './objects.ts';
export { AccountsPartitionedV1 } from './objects.ts';

export interface Env extends ObjectBindings {
  AUTHKIT_ISSUER: string;
  MCP_RESOURCE: string;
  AUTHKIT_AUTHORIZE_URL: string;
  CONSOLE_SECRET?: string;
  AUTH_RATE_LIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  DCR_RATE_LIMIT?: { limit(input: { key: string }): Promise<{ success: boolean }> };
}

let cached: { env: Env; app: ReturnType<typeof createApp> } | undefined;
function appFor(env: Env): ReturnType<typeof createApp> {
  if (cached?.env !== env) {
    const resource = new URL(env.MCP_RESOURCE);
    const backend = durableBackend(env,true);
    cached = { env, app: createApp({
      verifier: createVerifier({ issuer: env.AUTHKIT_ISSUER, resource }), resource, issuer: env.AUTHKIT_ISSUER,
      allowedHosts: [resource.hostname, ...localhostAllowedHostnames()], backend,
      authRateLimit: env.AUTH_RATE_LIMIT ?? { async limit() { throw new Error('Missing AUTH_RATE_LIMIT'); } },
      registerRateLimit: env.DCR_RATE_LIMIT ?? { async limit() { throw new Error('Missing DCR_RATE_LIMIT'); } },
      signinUrl: env.AUTHKIT_AUTHORIZE_URL,
      ...(env.CONSOLE_SECRET ? { console: { secret: env.CONSOLE_SECRET, backend } } : {}),
    }) };
  }
  return cached.app;
}
export default {
  fetch(request: Request, env: Env): Promise<Response> { return appFor(env).fetch(request); },
};
