import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import type { Client } from '@modelcontextprotocol/client';

type Rpc = { jsonrpc: string; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
type Listener = (event: { preventDefault(): void }) => void;
class Element {
  ownText = '';
  children: Element[] = [];
  value = '';
  disabled = true;
  listeners = new Map<string, Listener>();
  set textContent(value: string) { this.ownText = value; this.children = []; }
  get textContent(): string { return this.ownText + this.children.map((c) => c.textContent).join(' '); }
  append(...elements: Element[]) { this.children.push(...elements); }
  replaceChildren(...elements: Element[]) { this.ownText = ''; this.children = elements; }
  addEventListener(name: string, callback: Listener) { this.listeners.set(name, callback); }
  dispatch(name: string) { this.listeners.get(name)?.({ preventDefault() {} }); }
}
/** Spec postMessage host + minimal DOM. Executes the exact resource's bundled App,
 * not a copy of its logic. Network and direct navigation are deliberately absent. */
export class AppsHost {
  readonly messages: Rpc[] = [];
  readonly opened: string[] = [];
  readonly nodes = new Map<string, Element>();
  readonly fields = new Map<string, Element>();
  readonly errors: unknown[] = [];
  private listeners = new Set<(event: unknown) => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  dispose() { for (const timer of this.timers) clearTimeout(timer); this.listeners.clear(); }
  private readonly parent = { postMessage: (message: Rpc) => {
    this.messages.push(message);
    void this.receive(message).catch((error: unknown) => { this.errors.push(error); });
  } };
  constructor(html: string, client: Client) {
    for (const match of html.matchAll(/id="([^"]+)"/g)) this.nodes.set(match[1]!, new Element());
    for (const form of html.matchAll(/<form id="([^"]+)">([\s\S]*?)<\/form>/g)) {
      for (const field of form[2]!.matchAll(/name="([^"]+)"/g)) this.fields.set(`${form[1]}:${field[1]}`, new Element());
    }
    const kind = /data-view="([^"]+)"/.exec(html)![1]!;
    const window = {
      parent: this.parent,
      addEventListener: (name: string, listener: (event: unknown) => void) => { assert.equal(name, 'message'); this.listeners.add(listener); },
      removeEventListener: (_name: string, listener: (event: unknown) => void) => { this.listeners.delete(listener); },
    };
    this.call = (args) => client.callTool(args);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    runInNewContext(script, { window, document: {
      body: { dataset: { view: kind } },
      getElementById: (id: string) => this.nodes.get(id) ?? null,
      createElement: () => new Element(),
      querySelectorAll: () => [this.nodes.get('refresh')!, this.nodes.get('signin')!],
      querySelector: (selector: string) => { const m = /#([^ ]+) \[name="([^"]+)"\]/.exec(selector)!; return this.fields.get(`${m[1]}:${m[2]}`); },
    }, console: { debug() {}, warn() {}, error: (...args: unknown[]) => { this.errors.push(args); } },
    setTimeout: (callback: () => void, delay: number) => { const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, delay); this.timers.add(timer); return timer; },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); this.timers.delete(timer); },
    AbortController, URL, TextEncoder, TextDecoder, crypto,
    fetch: () => { throw new Error('A view must not fetch'); },
    }, { timeout: 5000, contextCodeGeneration: { strings: false, wasm: false } });
  }
  private call: (args: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
  private async receive(message: Rpc) {
    switch (message.method) {
      case 'ui/initialize':
        this.send({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: message.params!.protocolVersion, hostInfo: { name: 'test-host', version: '1.0.0' },
          hostCapabilities: { serverTools: {}, openLinks: {} }, hostContext: {},
        } });
        break;
      case 'ui/notifications/initialized': break;
      case 'tools/call':
        this.send({ jsonrpc: '2.0', id: message.id, result: await this.call(message.params as { name: string; arguments?: Record<string, unknown> }) });
        break;
      case 'ui/open-link':
        this.opened.push(message.params!.url as string);
        this.send({ jsonrpc: '2.0', id: message.id, result: {} });
        break;
      default: throw new Error(`Unexpected view side effect: ${message.method}`);
    }
  }
  send(message: Rpc, source: object = this.parent) { for (const listener of this.listeners) listener({ source, data: message }); }
  notify(method: string, params: Record<string, unknown>) { this.send({ jsonrpc: '2.0', method, params }); }
  async until(condition: () => boolean): Promise<void> {
    for (let turn = 0; turn < 100; turn++) { await setImmediate(); if (condition()) { assert.deepEqual(this.errors, []); return; } }
    assert.fail(`Host condition not met; errors: ${JSON.stringify(this.errors)}; status: ${this.nodes.get('status')!.textContent}; messages: ${JSON.stringify(this.messages)}`);
  }
  click(id: string) { assert.equal(this.nodes.get(id)!.disabled, false); this.nodes.get(id)!.dispatch('click'); }
  submit(id: string, values: Record<string, string>) {
    for (const [name, value] of Object.entries(values)) this.fields.get(`${id}:${name}`)!.value = value;
    this.nodes.get(id)!.dispatch('submit');
  }
  get text() { return this.nodes.get('overview')!.textContent; }
}
