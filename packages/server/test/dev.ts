// Local Playwright-only entry. The production Worker never imports this module.
import worker, { EnclaveObject, Registry, type Env } from '../src/index.js';
export { EnclaveObject, Registry };

const messages = new Map<string, string>();
const agentRates = new Map<string, { count: number; since: number }>();
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__test/email' && url.hostname === 'localhost') {
      const address = url.searchParams.get('address') ?? '';
      return Response.json({ text: messages.get(address) ?? null }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const email = { send: async (message: { to: string; text: string }) => { messages.set(message.to, message.text); return { messageId: 'local' }; } };
    const agentRate = { limit: async ({ key }: { key: string }) => {
      const old = agentRates.get(key), now = Date.now();
      const next = old && now - old.since < 60_000 ? { count: old.count + 1, since: old.since } : { count: 1, since: now };
      agentRates.set(key, next);
      return { success: next.count <= 10 };
    } };
    return worker.fetch(request, { ...env, MAGIC_EMAIL: email as unknown as Env['MAGIC_EMAIL'], AGENT_SESSION_RATE: agentRate });
  },
};
