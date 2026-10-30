import type { McpServer } from '@modelcontextprotocol/server';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod';
import { v2View, v2Uris } from '../../apps/src/v2-contract.ts';
import { Refused, parseCommand, type CoordinationBackend, type ToolData, type ToolName } from './commands.ts';
import { libraryInputs } from './library-inputs.ts';
import { roundInputs } from './round-inputs.ts';
import { forumInputs } from './forum-inputs.ts';
const id = z.string().min(1).max(200), acting = { actingAgent: id.optional() }, journey = { journeyId: id, ...acting };
const librarySelector = libraryInputs.library_search.extend({ itemId: id.optional() });
const roundSelector = z.object({ ...journey, roundId: id.optional() }).strict();
const own = z.object({ ...journey, roundId: id }).strict();
const forumSelector = z.object({ ...journey, boardId: id.optional(), topicId: id.optional() }).strict().refine(v => !(v.boardId && v.topicId));
const agentsSelector = z.object({ journeyId: id.optional(), agentId: id.optional(), ...acting }).strict();
const reply = z.object({ ...journey, topicId: id.optional(), itemId: id.optional(), roundId: id.optional(), body: z.string().trim().min(1).max(4096), replyTo: id.optional() }).strict().refine(v => [v.topicId, v.itemId, v.roundId].filter(Boolean).length === 1);
const registrations = [
  ['library_view', 'library', librarySelector, false], ['apps_v2_library', 'library', librarySelector, true],
  ['round_view', 'round', roundSelector, false], ['apps_v2_round', 'round', roundSelector, true],
  ['agent_capabilities_view', 'agents', agentsSelector, false], ['apps_v2_agents', 'agents', agentsSelector, true],
  ['forum_view_v3', 'forum', forumSelector, false], ['apps_v2_forum', 'forum', forumSelector, true],
  ['apps_v2_topic', 'forum', forumInputs.topic_create, true], ['apps_v2_reply', 'forum', reply, true],
  ['apps_v2_interview_read', 'round', own, true],
  ['apps_v2_interview_write', 'round', roundInputs.interview_write.extend({ journeyId: id }), true],
  ['apps_v2_interview_share', 'round', own, true],
  ['apps_v2_contribute', 'round', roundInputs.round_contribute.extend({ journeyId: id }), true],
] as const;
export function registerV2Apps(server: McpServer, subject: string | undefined, backend?: CoordinationBackend, clientId?: string) {
  for (const [name, kind, inputSchema, appOnly] of registrations) registerAppTool(server, name, {
    description: `Wayfinding ${kind} App. Live authority; library metadata only; own interview only. Synthetic data only.`, inputSchema,
    _meta: { ui: { resourceUri: v2Uris[kind], visibility: appOnly ? ['app'] : ['model', 'app'] } },
  }, async (args: Record<string, unknown>) => {
    try {
      if (!subject || !backend) throw new Refused('Sign in to use this view');
      const acting = typeof args.actingAgent === 'string' ? { actingAgent: args.actingAgent } : {};
      const execute = (tool: ToolName, input: Record<string, unknown>) => backend.execute(subject, parseCommand(tool, input), clientId);
      const checkJourney = (data: ToolData) => { if (data.journeyId !== args.journeyId) throw new Refused('View journey mismatch'); return data; };
      const conversation = async (target: { itemId: unknown } | { roundId: unknown }) => {
        const data = await execute('conversation_read', { journeyId: args.journeyId, target, ...acting });
        // conversation_read puts posts alongside its topic summary, not inside it.
        return { topic: data.topic ? { ...z.record(z.string(), z.unknown()).parse(data.topic), posts: data.posts } : null };
      };
      async function library(): Promise<ToolData> {
        if (args.itemId) {
          const item = checkJourney(await execute('library_get', { itemId: args.itemId, ...acting }));
          return { view: 'library', journeyId: args.journeyId, items: [], item, conversation: await conversation({ itemId: args.itemId }) };
        }
        const data = await execute('library_search', { journeyId: args.journeyId, query: args.query, kind: args.kind, label: args.label, projectId: args.projectId, includeProjects: args.includeProjects, ...acting });
        return { view: 'library', journeyId: args.journeyId, items: data.items };
      }
      async function round(interview?: ToolData): Promise<ToolData> {
        const listed = await execute('round_list', { journeyId: args.journeyId, ...acting });
        const detail = args.roundId ? checkJourney(await execute('round_read', { roundId: args.roundId, ...acting })) : undefined;
        return { view: 'round', journeyId: args.journeyId, rounds: listed.rounds, round: detail, conversation: detail ? await conversation({ roundId: args.roundId }) : undefined, interview };
      }
      async function forum(): Promise<ToolData> {
        if (args.topicId) return { view: 'forum', journeyId: args.journeyId, topic: checkJourney(await execute('topic_read', { topicId: args.topicId, ...acting })) };
        const data = await execute(args.boardId ? 'topic_list' : 'forum_boards', { journeyId: args.journeyId, ...(args.boardId ? { boardId: args.boardId } : {}), ...acting });
        return { view: 'forum', journeyId: args.journeyId, boards: data.boards, topics: data.topics };
      }
      let data: ToolData;
      if (name === 'apps_v2_reply') {
        const target = args.itemId ? { itemId: args.itemId } : args.roundId ? { roundId: args.roundId } : undefined;
        if (target) {
          await conversation(target);
          await execute('conversation_post', { journeyId: args.journeyId, target, body: args.body, replyTo: args.replyTo, ...acting });
          data = args.itemId ? await library() : await round();
        } else {
          checkJourney(await execute('topic_read', { topicId: args.topicId, ...acting }));
          await execute('post_create', { topicId: args.topicId, body: args.body, replyTo: args.replyTo, ...acting }); data = await forum();
        }
      } else if (name === 'apps_v2_topic') {
        const listed = await execute('topic_list', { boardId: args.boardId, ...acting });
        const created = await execute('topic_create', { boardId: args.boardId, title: args.title, body: args.body, ...acting });
        data = { view: 'forum', journeyId: listed.journeyId, topic: await execute('topic_read', { topicId: created.topicId, ...acting }) };
      } else if (name.startsWith('apps_v2_interview') || name === 'apps_v2_contribute') {
        // Check the selected journey and read capability before any write. Never accept a person selector.
        checkJourney(await execute('round_read', { roundId: args.roundId, ...acting }));
        if (name !== 'apps_v2_interview_read') {
          const tool = name === 'apps_v2_contribute' ? 'round_contribute' : name === 'apps_v2_interview_write' ? 'interview_write' : 'interview_share';
          await execute(tool, { roundId: args.roundId, ...(tool === 'interview_write' || tool === 'round_contribute' ? { text: args.text } : {}), ...acting });
        }
        data = await round(name === 'apps_v2_contribute' ? undefined : await execute('interview_read', { roundId: args.roundId, ...acting }));
      } else if (kind === 'library') data = await library();
      else if (kind === 'round') data = await round();
      else if (kind === 'forum') data = await forum();
      else {
        const result = args.agentId ? await execute('agent_capabilities', { agentId: args.agentId, ...acting }) : await execute('agent_list', { ...acting });
        data = { view: 'agents', journeyId: args.journeyId, agents: args.agentId ? [result] : result.agents };
      }
      const projected = v2View.parse(data);
      return { content: [{ type: 'text' as const, text: JSON.stringify(projected) }], structuredContent: projected };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Refused ? error.message : 'View operation failed' }] };
    }
  });
}
