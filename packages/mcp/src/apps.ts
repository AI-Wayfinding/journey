import type { McpServer } from '@modelcontextprotocol/server';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import * as z from 'zod';
import { releasedViews } from '@ai-wayfinding/apps/views';
import { journeyView, projectView, artifactsView, type ViewKind } from '@ai-wayfinding/apps/contract';
import { inputs, parseCommand, Refused, type CoordinationBackend, type ToolData, type ToolName } from './commands.ts';

import { registerV2Apps } from './v2-apps.ts';
import { registerForumApps } from './forum-apps.ts';
export interface ReleasedView { uri: string; kind: ViewKind | 'forum' | 'library' | 'round' | 'agents'; html: string }
// Add releases; never replace or remove a released URI when shipping a successor.
export function registerViewResources(server: McpServer, releases: readonly ReleasedView[] = releasedViews) {
  for (const release of releases) registerAppResource(server, release.uri, release.uri,
    { mimeType: RESOURCE_MIME_TYPE, description: `Wayfinding ${release.kind} view` }, async () => ({
      contents: [{ uri: release.uri, mimeType: RESOURCE_MIME_TYPE, text: release.html,
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }],
    }));
}
function project(data: ToolData, kind: ViewKind, projectId?: unknown): ToolData {
  switch (kind) {
    case 'journey': return journeyView.parse({ view: kind, journeyId: data.journeyId, name: data.name,
      policy: data.policy, defaultRole: data.defaultRole, members: data.members, agents: data.agents, projects: data.projects, pending: data.pending });
    case 'project': {
      const projects = z.array(projectView.shape.project).parse(data.projects);
      const selected = projects.find((p) => p.projectId === projectId);
      if (!selected) throw new Refused('Project not found');
      return projectView.parse({ view: kind, journeyId: data.journeyId, project: selected });
    }
    case 'artifacts': {
      const rows = z.array(artifactsView.shape.artifacts.element.extend({ deleted: z.boolean() })).parse(data.artifacts);
      return artifactsView.parse({ view: kind, journeyId: data.journeyId, artifacts: rows.filter((a) => !a.deleted) });
    }
  }
}
interface ViewTool { name: string; kind: ViewKind; command: ToolName; appOnly?: boolean; projectSelector?: boolean }
const viewTools: ViewTool[] = [
  { name: 'journey_view', kind: 'journey', command: 'journey_read' },
  { name: 'project_view', kind: 'project', command: 'journey_read', projectSelector: true },
  { name: 'artifact_list_view', kind: 'artifacts', command: 'journey_read' },
  { name: 'apps_journey_refresh', kind: 'journey', command: 'journey_read', appOnly: true },
  { name: 'apps_project_refresh', kind: 'project', command: 'journey_read', projectSelector: true, appOnly: true },
  { name: 'apps_artifacts_refresh', kind: 'artifacts', command: 'journey_read', appOnly: true },
  { name: 'apps_journey_policy', kind: 'journey', command: 'journey_policy', appOnly: true },
  { name: 'apps_journey_invite', kind: 'journey', command: 'journey_invite', appOnly: true },
  { name: 'apps_project_update', kind: 'project', command: 'project_update', appOnly: true },
  { name: 'apps_artifact_rename', kind: 'artifacts', command: 'artifact_rename', appOnly: true },
];
export function registerApps(server: McpServer, subject: string | undefined, backend?: CoordinationBackend, clientId?: string) {
  registerViewResources(server);
  registerForumApps(server, subject, backend, clientId);
  registerV2Apps(server, subject, backend, clientId);
  for (const tool of viewTools) {
    // Reuse the strict project-selector input, but never join on view/refresh.
    const inputSchema: z.ZodObject<z.ZodRawShape> = tool.projectSelector ? inputs.project_join : inputs[tool.command];
    registerAppTool(server, tool.name, { description: `Wayfinding ${tool.name.replaceAll('_', ' ')}. Metadata only.`, inputSchema,
      _meta: { ui: { resourceUri: `ui://wayfinding/v1/${tool.kind}.html`, visibility: tool.appOnly ? ['app'] : ['model', 'app'] } },
    }, async (args: Record<string, unknown>) => {
      try {
        if (!subject) throw new Refused('No signed-in account on this request');
        if (!backend) throw new Refused('Coordination storage is not configured');
        const command = tool.projectSelector
          ? parseCommand('journey_read', { journeyId: args.journeyId, ...(typeof args.actingAgent === 'string' ? { actingAgent: args.actingAgent } : {}) })
          : parseCommand(tool.command, args);
        const data = project(await backend.execute(subject, command, clientId), tool.kind, args.projectId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Refused ? error.message : 'View operation failed' }] };
      }
    });
  }
}
