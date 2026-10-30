import type { McpServer } from '@modelcontextprotocol/server';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod';
import { forumView } from '@ai-wayfinding/apps/forum-contract';
import { Refused, parseCommand, type CoordinationBackend, type ToolData } from './commands.ts';
import { forumInputs } from './forum-inputs.ts';
const id = z.string().min(1).max(200);
const selector = z.object({ journeyId: id, boardId: id.optional(), topicId: id.optional(), actingAgent: id.optional() }).strict().refine(v => !(v.boardId && v.topicId), 'Choose board or topic');
export function registerForumApps(server: McpServer, subject: string | undefined, backend?: CoordinationBackend, clientId?: string) {
  const tools = [
    { name: 'forum_view', schema: selector, appOnly: false },
    { name: 'forum_topic_create_view', schema: forumInputs.topic_create, appOnly: true },
    { name: 'forum_post_create_view', schema: forumInputs.post_create, appOnly: true },
  ] as const;
  for (const tool of tools) registerAppTool(server, tool.name, {
    description: 'Journey forum App: browse boards, topics and attributed threads; post through live server authority. Synthetic data only.',
    inputSchema: tool.schema,
    _meta: { ui: { resourceUri: 'ui://wayfinding/v2/forum.html', visibility: tool.appOnly ? ['app'] : ['model', 'app'] } },
  }, async (args: Record<string, unknown>) => {
    try {
      if (!subject || !backend) throw new Refused('Sign in to use the forum');
      const acting = typeof args.actingAgent === 'string' ? { actingAgent: args.actingAgent } : {};
      const execute = (name: Parameters<typeof parseCommand>[0], input: Record<string, unknown>) => backend.execute(subject, parseCommand(name, input), clientId);
      let data: ToolData;
      if (tool.name === 'forum_topic_create_view') {
        // A view must be readable before it can mutate, including for bound agents.
        await execute('topic_list', { boardId: args.boardId, ...acting });
        const created = await execute('topic_create', args);
        data = { journeyId: created.journeyId, topic: await execute('topic_read', { topicId: created.topicId, ...acting }) };
      } else if (tool.name === 'forum_post_create_view') {
        await execute('topic_read', { topicId: args.topicId, ...acting });
        const created = await execute('post_create', args);
        data = { journeyId: created.journeyId, topic: await execute('topic_read', { topicId: created.topicId, ...acting }) };
      } else if (args.topicId !== undefined) {
        const topic = await execute('topic_read', { topicId: args.topicId, ...acting });
        if (topic.journeyId !== args.journeyId) throw new Refused('Forum journey mismatch');
        data = { journeyId: topic.journeyId, topic };
      } else if (args.boardId !== undefined) {
        data = await execute('topic_list', { journeyId: args.journeyId, boardId: args.boardId, ...acting });
      } else data = await execute('forum_boards', { journeyId: args.journeyId, ...acting });
      const projected = forumView.parse({ view: 'forum', journeyId: data.journeyId, boards: data.boards, topics: data.topics, topic: data.topic });
      return { content: [{ type: 'text' as const, text: JSON.stringify(projected) }], structuredContent: projected };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Refused ? error.message : 'Forum view operation failed' }] };
    }
  });
}
