import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { inputs, TOOL_NAMES, parseCommand, Refused, type CoordinationBackend } from './commands.ts';

function subjectOf(extra: Record<string, unknown> | undefined): string | undefined {
  const sub = extra?.['sub'];
  return typeof sub === 'string' && sub !== '' ? sub : undefined;
}

export function buildServer(ctx: Parameters<McpServerFactory>[0], backend?: CoordinationBackend): McpServer {
  const server = new McpServer({ name: 'wayfinding', version: '0.1.0' }, { capabilities: { tools: {} } });
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
  return server;
}
