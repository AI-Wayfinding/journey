import * as z from 'zod';
function parseJSON(text: string): unknown { try { return JSON.parse(text); } catch { throw new Refused('Invalid form JSON'); } }
import { Refused } from '../commands.ts';

/** Bound all browser input before decoding JSON or URL-encoded form fields. */
export async function formBody(request: Request, csrf: string, origin: string, maxBytes=96*1024): Promise<Record<string, unknown>> {
  // Browsers may send `Origin: null` for privacy; then accept only a browser-set Sec-Fetch-Site: same-origin, which pages cannot forge.
  const sent = request.headers.get('origin');
  const sameOrigin = sent === origin || (sent === 'null' && request.headers.get('sec-fetch-site') === 'same-origin');
  if (!sameOrigin) throw new Refused('Form origin refused');
  const reader = request.body?.getReader();
  if (!reader) throw new Refused('Form body required');
  let text = '', size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maxBytes) throw new Refused('Form too large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const type = request.headers.get('content-type')?.split(';')[0];
  let body: Record<string, unknown>;
  if (type === 'application/json') body = z.record(z.string(), z.unknown()).parse(parseJSON(text));
  else if (type === 'application/x-www-form-urlencoded') {
    const fields = new URLSearchParams(text);
    body = {};
    for (const key of new Set(fields.keys())) {
      const values = fields.getAll(key);
      if (key === 'capabilities' || key === 'journeys') body[key] = values;
      else if (values.length === 1) body[key] = values[0];
      else throw new Refused('Duplicate form field');
    }
  } else throw new Refused('Unsupported form encoding');
  if (body.csrf !== csrf) throw new Refused('CSRF token required');
  return body;
}
