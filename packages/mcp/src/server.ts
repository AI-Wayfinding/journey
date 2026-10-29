import { McpServer, ProtocolError, ResourceTemplate, type McpServerFactory, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { inputs, TOOL_NAMES, parseCommand, Refused, type CoordinationBackend } from './commands.ts';
import { registerApps } from './apps.ts';
import { inboxJourney } from './inbox.ts';

function subjectOf(extra: Record<string, unknown> | undefined): string | undefined {
  const sub = extra?.['sub'];
  return typeof sub === 'string' && sub !== '' ? sub : undefined;
}

export function buildServer(ctx: Parameters<McpServerFactory>[0], backend?: CoordinationBackend): McpServer {
  const server = new McpServer({ name: 'wayfinding', version: '0.1.0' }, { capabilities: {
    tools: {}, resources: { subscribe: ctx.era === 'modern' }, extensions: { 'io.modelcontextprotocol/tasks': {} },
  } });
  server.registerResource('task-inbox', new ResourceTemplate('wayfinding://journey/{journeyId}/inbox', { list: undefined }), {
    description: 'Tasks addressed to you or your live agents, plus unassigned tasks. Poll when offline.', mimeType: 'application/json',
  }, async (uri) => {
    const subject = subjectOf(ctx.authInfo?.extra);
    if (!subject || !backend?.inbox) throw new Refused('Authenticated inbox storage is required');
    const inbox = await backend.inbox(subject, inboxJourney(uri.href));
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(inbox) }] };
  });
  server.registerTool('whoami', {
    description: 'Report the authenticated WorkOS subject.', inputSchema: z.object({}),
    outputSchema: z.object({ subject: z.string(), era: z.enum(['legacy', 'modern']) }),
  }, async () => {
    const subject = subjectOf(ctx.authInfo?.extra);
    if (!subject) return { isError: true, content: [{ type: 'text', text: 'No signed-in account on this request.' }] };
    const result = { subject, era: ctx.era };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  });
  for (const name of TOOL_NAMES) {
    const inputSchema: z.ZodObject<z.ZodRawShape> = inputs[name];
    server.registerTool(name, {
      description: `Wayfinding: ${name.replaceAll('_', ' ')}. Relay data is opaque base64; artifact metadata tools never accept plaintext content. Personal group IDs are personal_<personId>.`,
      inputSchema,
    }, async (args: Record<string, unknown>) => {
      try {
        const subject = subjectOf(ctx.authInfo?.extra);
        if (!subject) throw new Refused('No signed-in account on this request');
        if (!backend) throw new Refused('Coordination storage is not configured');
        const result = await backend.execute(subject, parseCommand(name, args));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const message = error instanceof Refused ? error.message : 'Coordination operation failed';
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    });
  }
  // SEP-2663 is an extension, not the SDK's older core Tasks implementation.
  const metadata = z.record(z.string(), z.unknown()).optional();
  const base = { taskId: z.string().min(1).max(200), _meta: metadata };
  const declared = (request: ServerContext, meta?: Record<string, unknown>): boolean => {
    const envelope: unknown = request.mcpReq.envelope;
    const capabilities: unknown = typeof envelope === 'object' && envelope !== null && 'io.modelcontextprotocol/clientCapabilities' in envelope
      ? envelope['io.modelcontextprotocol/clientCapabilities'] : meta?.['io.modelcontextprotocol/clientCapabilities'];
    if (typeof capabilities !== 'object' || capabilities === null || !('extensions' in capabilities)) return false;
    const extensions = capabilities.extensions;
    if (typeof extensions !== 'object' || extensions === null || !Object.hasOwn(extensions, 'io.modelcontextprotocol/tasks')) return false;
    const value: unknown = (extensions as Record<string, unknown>)['io.modelcontextprotocol/tasks'];
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  };
  for (const method of ['get', 'update', 'cancel'] as const) {
    const params = method === 'update'
      ? z.object({ ...base, inputResponses: z.record(z.string(), z.unknown()).optional() }).strict()
      : z.object(base).strict();
    server.server.setRequestHandler(`tasks/${method}`, { params }, async (args, request) => {
      if (!declared(request, args._meta)) throw new ProtocolError(-32021, 'Client must declare io.modelcontextprotocol/tasks', {
        requiredCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
      });
      // The SDK lifts MRTR responses out of params in the modern era; legacy keeps them there.
      if (method === 'update' && !('inputResponses' in args) && request.mcpReq.inputResponses === undefined) throw new ProtocolError(-32602, 'inputResponses is required');
      const subject = subjectOf(ctx.authInfo?.extra);
      if (!subject || !backend?.task) throw new ProtocolError(-32603, 'Authenticated task storage is required');
      try {
        // No input requests are outstanding: SEP-2663 says to ignore unknown/satisfied responses.
        // Copy only the task identifier, never caller-supplied state or input responses, to storage.
        return await backend.task(subject, method, args.taskId);
      } catch (error) {
        if (error instanceof Refused) throw new ProtocolError(-32602, error.message);
        throw new ProtocolError(-32603, 'Task storage operation failed');
      }
    });
  }
  registerApps(server, subjectOf(ctx.authInfo?.extra), backend);
  return server;
}
