import type { ServerEvent, ServerEventBus } from '@modelcontextprotocol/server';
import { Refused } from './commands.ts';

export function inboxJourney(uri: string): string {
  const match = /^wayfinding:\/\/journey\/(journey_[0-9a-f-]{36})\/inbox$/.exec(uri);
  if (!match?.[1]) throw new Refused('Unknown inbox resource');
  return match[1];
}

/** Bound the authorization preflight without buffering an arbitrary request body. */
export async function subscriptionBody(request: Request): Promise<string> {
  const reader = request.clone().body?.getReader();
  if (!reader) throw new Refused('Subscription body is required');
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > 65536) throw new Refused('Subscription request too large');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Each bus belongs to one authenticated listen request, not a shared Worker isolate. */
export class InboxBus implements ServerEventBus {
  private readonly readers: ReadableStreamDefaultReader<Uint8Array>[];
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly onClose: () => void;
  private closed = false;
  private started = false;
  constructor(streams: ReadableStream<Uint8Array>[], onClose: () => void) {
    this.readers = streams.map((stream) => stream.getReader()); this.onClose = onClose;
  }
  publish(event: ServerEvent): void { if (!this.closed) for (const listener of this.listeners) listener(event); }
  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.started) { this.started = true; for (const reader of this.readers) void this.pump(reader); }
    return () => { this.listeners.delete(listener); void this.close(); };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.listeners.clear(); this.onClose();
    await Promise.all(this.readers.map((reader) => reader.cancel().catch(() => undefined)));
  }
  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const end = pending.indexOf('\n');
          if (end < 0) break;
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line) continue;
          const value: unknown = JSON.parse(line);
          if (typeof value === 'object' && value !== null && 'uri' in value && typeof value.uri === 'string') this.publish({ kind: 'resource_updated', uri: value.uri });
        }
      }
    } catch { /* Disconnect ends this subscription; clients re-listen or poll. */ }
    finally { void this.close(); reader.releaseLock(); }
  }
}
