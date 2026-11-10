import { randomUUID } from 'node:crypto';
import type { HostRef } from '@emdash/core/primitives/host/api';
import type { HostRuntimesClient } from '@emdash/core/services/runtime-broker/api';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '@core/services/app-db/node/db';
import { appDbPokes } from '@core/services/app-db/node/pokes';
import { projects } from '@core/services/app-db/node/schema';
import { projectFromRow } from '../../node/operations/getProjects';
import { registerRepositoryWorkspace } from '../../node/operations/register-repository-workspace';
import { projectEvents } from './project-events';

/** 历史会话始终使用原目录；只登记现有目录，不创建 worktree 或执行初始化脚本。 */
export async function ensureHistoryProject(
  db: AppDb,
  client: HostRuntimesClient,
  host: HostRef,
  cwd: string
): Promise<{ projectId: string; workspaceId: string }> {
  const workspace = await client.workspaceRegistry.createWorkspace({
    workspaceId: randomUUID(),
    path: cwd,
  });
  if (!workspace.success)
    throw new Error(`Could not open the original directory: ${workspace.error.type}`);
  const existing = db
    .select()
    .from(projects)
    .where(and(eq(projects.repositoryWorkspaceId, workspace.data.id), isNull(projects.deletedAt)))
    .get();
  if (existing) return { projectId: existing.id, workspaceId: workspace.data.id };
  const name =
    cwd
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || cwd;
  const result = registerRepositoryWorkspace(db, {
    project: { id: randomUUID(), name, baseRef: null },
    host,
    record: workspace.data,
  });
  if (!result.success) {
    if (result.error.type === 'project-already-linked')
      return { projectId: result.error.projectId, workspaceId: workspace.data.id };
    throw new Error(`Could not register the original directory: ${result.error.type}`);
  }
  const project = projectFromRow(result.data, {
    path: workspace.data.path,
    location: host.type === 'remote' ? 'remote' : 'local',
    sshConnectionId: host.type === 'remote' ? host.id : null,
  });
  if (!project) throw new Error('The original directory could not be associated with a project.');
  projectEvents._emit('project:created', project);
  appDbPokes.projects.poke({ projectId: project.id });
  return { projectId: project.id, workspaceId: workspace.data.id };
}
