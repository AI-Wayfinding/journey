import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import * as z from 'zod';

/** The subject AuthKit put in the token's `sub` claim (the WorkOS user id). */
function subjectOf(extra: Record<string, unknown> | undefined): string | undefined {
  const sub = extra?.['sub'];
  return typeof sub === 'string' && sub !== '' ? sub : undefined;
}

/**
 * One fresh server per request, for both protocol eras. The subject comes
 * only from the verified token the gate passed in, never from tool input.
 */
export const buildServer: McpServerFactory = (ctx) => {
  const server = new McpServer({ name: 'wayfinding', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.registerTool(
    'whoami',
    {
      description: 'Report the signed-in account: the WorkOS user id from the access token.',
      inputSchema: z.object({}),
      outputSchema: z.object({ subject: z.string(), era: z.enum(['legacy', 'modern']) }),
    },
    async () => {
      const subject = subjectOf(ctx.authInfo?.extra);
      if (subject === undefined) {
        return { isError: true, content: [{ type: 'text', text: 'No signed-in account on this request.' }] };
      }
      const result = { subject, era: ctx.era };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  return server;
};
