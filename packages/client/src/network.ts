import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

let configured = false;
export function proxyConfigured(): boolean {
  return Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY);
}

/** Plain-words fallback for sandboxes that cannot reach the journey server but can read web pages. */
export const LINK_FALLBACK = 'If this environment can\'t reach app.wayfinding.support but you can read web pages, ask the person to open their journey, go to People & agents \u2192 Add agent by link, and give you the link. Read it with your web fetch tool; it returns JSON. That access is read-only.';

export class NetworkError extends Error {
  readonly exitCode = 5;
  readonly fallback = LINK_FALLBACK;
  /** The failure on its own, without the fallback text. */
  readonly reason: string;
  constructor(reason: string, options?: ErrorOptions) {
    super(reason + '\n\n' + LINK_FALLBACK, options);
    this.reason = reason;
  }
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
