import { localhostAllowedHostnames } from '@modelcontextprotocol/server';
import { createVerifier } from './auth.ts';
import { createApp } from './app.ts';

/** Bindings from `wrangler.jsonc`. */
export interface Env {
  AUTHKIT_ISSUER: string;
  MCP_RESOURCE: string;
}

let cached: { key: string; app: ReturnType<typeof createApp> } | undefined;

/** One app per isolate and configuration, so the remote JWKS cache survives between requests. */
function appFor(env: Env): ReturnType<typeof createApp> {
  const key = `${env.AUTHKIT_ISSUER} ${env.MCP_RESOURCE}`;
  if (cached?.key !== key) {
    const resource = new URL(env.MCP_RESOURCE);
    const app = createApp({
      verifier: createVerifier({ issuer: env.AUTHKIT_ISSUER, resource }),
      resource,
      issuer: env.AUTHKIT_ISSUER,
      // The public hostname, plus localhost for `wrangler dev`.
      allowedHosts: [resource.hostname, ...localhostAllowedHostnames()],
    });
    cached = { key, app };
  }
  return cached.app;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return appFor(env).fetch(request);
  },
};
