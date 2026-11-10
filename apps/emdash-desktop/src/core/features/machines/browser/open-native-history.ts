import { when } from 'mobx';
import { getProjectManagerStore } from '@core/features/projects/api/browser/stores/project-selectors';
import { getTaskStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { getTaskComposition } from '@core/features/workbench/api/browser/task-composition-selectors';
import type { NavigateFnTyped } from '@core/primitives/navigation/browser/navigation-hooks';

/** 先等待服务器索引进入现有 store，再导航；否则新项目会被路由守卫重定向。 */
export async function openNativeHistoryLocation(
  location: { projectId: string; taskId: string; conversationId: string },
  navigate: NavigateFnTyped
): Promise<void> {
  const { projectId, taskId, conversationId } = location;
  await when(() => getProjectManagerStore().projects.has(projectId), { timeout: 15_000 });
  await getProjectManagerStore().hydrateProjectContext(projectId);
  await when(() => Boolean(getTaskStore(projectId, taskId)), { timeout: 15_000 });
  navigate(taskViewDef({ projectId, taskId }));
  await when(() => Boolean(getTaskComposition(projectId, taskId)), { timeout: 15_000 });
  const composition = getTaskComposition(projectId, taskId);
  if (!composition) throw new Error('The task closed before its conversation could be opened.');
  await composition.openConversation(conversationId);
}
