import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { importMarkdown } from './import.js';
import type { JourneyClient, AddInput } from './journey.js';

const text = { type: 'string' as const };
const schema = (properties: Record<string, object>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const tools = [
  { name: 'add', description: 'Add an item to the journey. The person must approve read-write access first; the agent cannot change membership or access.', inputSchema: schema({ type: text, title: text, body: text, tags: { type: 'array', items: text } }, ['type', 'title', 'body']) },
  { name: 'import', description: 'Add Markdown files from this computer to the journey. The person must approve read-write access first.', inputSchema: schema({ path: text }, ['path']) },
  { name: 'list', description: 'List decrypted journey items, optionally by type. The person must approve access first.', inputSchema: schema({ type: text }) },
  { name: 'search', description: 'Find words in decrypted journey item titles, tags, and bodies. The person must approve access first.', inputSchema: schema({ text: text }) },
  { name: 'show', description: 'Read one journey item by its ID. The person must approve access first.', inputSchema: schema({ id: text }, ['id']) },
  { name: 'comment', description: 'Add a comment to a journey item. The person must approve read-write access first.', inputSchema: schema({ id: text, text: text }, ['id', 'text']) },
  { name: 'comments', description: 'Read comments for a journey item. The person must approve access first.', inputSchema: schema({ id: text }, ['id']) },
  { name: 'status', description: 'Check this journey and your approved scope.', inputSchema: schema({}) },
  { name: 'connect_status', description: 'Check whether a person has approved this agent for a journey. No journey access is granted by this tool.', inputSchema: schema({}) }
];
function field(args: Record<string, unknown>, name: string): string {
  if (typeof args[name] !== 'string' || !args[name]) throw new Error(name + ' must be text.');
  return args[name];
}
export function createWayfindingServer(getClient: () => Promise<JourneyClient>): Server {
  const server = new Server({ name: 'wayfinding', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = request.params.arguments ?? {};
    try {
      let result: unknown;
      if (request.params.name === 'connect_status') {
        try { const client = await getClient(); result = await client.status(); }
        catch (error) { result = { connected: false, message: error instanceof Error ? error.message : String(error) }; }
      } else {
        const client = await getClient();
        switch (request.params.name) {
          case 'add': {
            if (args.tags !== undefined && (!Array.isArray(args.tags) || !args.tags.every(tag => typeof tag === 'string'))) throw new Error('Journey tags must be text.');
            result = await client.add({ type: field(args, 'type'), title: field(args, 'title'), body: field(args, 'body'), tags: args.tags === undefined ? [] : [...args.tags] } satisfies AddInput); break;
          }
          case 'import': result = await importMarkdown(client, field(args, 'path')); break;
          case 'list': result = await client.list(typeof args.type === 'string' ? args.type : undefined); break;
          case 'search': result = await client.search(field(args, 'text')); break;
          case 'show': result = await client.show(field(args, 'id')); break;
          case 'comment': result = await client.comment(field(args, 'id'), field(args, 'text')); break;
          case 'comments': result = await client.comments(field(args, 'id')); break;
          case 'status': result = await client.status(); break;
          default: throw new Error('Unknown journey tool: ' + request.params.name);
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  return server;
}
export async function runMcp(getClient: () => Promise<JourneyClient>): Promise<void> {
  await createWayfindingServer(getClient).connect(new StdioServerTransport());
}
