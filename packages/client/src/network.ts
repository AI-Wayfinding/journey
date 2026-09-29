import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

let configured = false;
export function proxyConfigured(): boolean {
  return Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY);
}

export class NetworkError extends Error {
  readonly exitCode = 5;
}

export const networkFetch: typeof fetch = async (input, init) => {
  if (!configured) {
    if (proxyConfigured()) setGlobalDispatcher(new EnvHttpProxyAgent({
      httpsProxy: process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY,
    }));
    configured = true;
  }
  try { return await fetch(input, init); }
  catch (error) {
    let cause: unknown = error;
    const details: string[] = [];
    for (let i = 0; i < 4 && cause instanceof Error; i++) {
      const code = (cause as NodeJS.ErrnoException).code;
      const message = cause.message;
      if (code || (message && message !== 'fetch failed')) details.push([code, message].filter(Boolean).join(': '));
      cause = cause.cause;
    }
    const hint = proxyConfigured()
      ? 'Check the configured proxy; your workspace admin may need to allow app.wayfinding.support.'
      : 'If the host is unreachable, your workspace admin may need to allow app.wayfinding.support.';
    throw new NetworkError('Could not reach the journey server (' + (details.join('; ') || 'network error') + '). ' + hint, { cause: error });
  }
}
