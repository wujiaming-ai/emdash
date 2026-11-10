import { createHash, randomUUID } from 'node:crypto';
import { formatHostRef, type HostRef } from '@emdash/core/primitives/host/api';
import type { NativeSession } from '@emdash/core/runtimes/acp/api/client';
import type { HostRuntimesClient } from '@emdash/core/services/runtime-broker/api';
import { and, eq, isNull } from 'drizzle-orm';
import { ensureHistoryProject } from '@core/features/projects/api/node/history-project';
import type { ConversationConfigAcp } from '@core/primitives/conversations/api';
import type { AppDb } from '@core/services/app-db/node/db';
import { appDbPokes } from '@core/services/app-db/node/pokes';
import { projects, tasks } from '@core/services/app-db/node/schema';
import { createConversationRegistry, conversationRegistryTable } from '../api/node/registry';

export interface NativeHistoryLocation {
  projectId: string;
  taskId: string;
  conversationId: string;
}

/** 按主机和 provider 原生 ID 去重；导入只建立索引，模型请求由用户发送消息触发。 */
export async function openNativeHistory(
  db: AppDb,
  client: HostRuntimesClient,
  host: HostRef,
  session: NativeSession
): Promise<NativeHistoryLocation> {
  const previous = findNativeConversation(db, host, session);
  if (previous?.deletionTombstone) throw new Error('This conversation has a pending deletion.');
  if (previous && previous.workspacePath !== session.cwd)
    throw new Error('This session is already associated with a different working directory.');
  if (previous?.projectId && previous.taskId) {
    const task = db.select().from(tasks).where(eq(tasks.id, previous.taskId)).get();
    const project = db.select().from(projects).where(eq(projects.id, previous.projectId)).get();
    if (!task || task.deletedAt || !project || project.deletedAt)
      throw new Error(
        'The linked task or project is being deleted. Try again after deletion finishes.'
      );
    return { projectId: previous.projectId, taskId: previous.taskId, conversationId: previous.id };
  }
  const { projectId, workspaceId } = await ensureHistoryProject(db, client, host, session.cwd);
  const conversationId = previous?.id ?? nativeConversationId(host, session);
  const retired = db
    .select()
    .from(conversationRegistryTable)
    .where(eq(conversationRegistryTable.id, conversationId))
    .get();
  if (retired?.untrackedAt || retired?.deletionTombstone)
    throw new Error('This selection was removed. Refresh CLI history before opening it again.');
  const config = { version: '1' as const, type: 'acp' as const };
  await bindNativeConversation(client, conversationId, session, config);
  const taskId = randomUUID();
  registerNativeTask(db, host, session, { projectId, taskId, conversationId }, workspaceId, config);
  appDbPokes.tasks.poke({ projectId, taskId });
  appDbPokes.conversations.poke({ projectId, taskId });
  return { projectId, taskId, conversationId };
}

/** 选择凭证派生 UUID v8：同一次选择可重试，刷新后重新导入不复用已删除的身份。 */
function nativeConversationId(host: HostRef, session: NativeSession): string {
  const bytes = createHash('sha256')
    .update(`${formatHostRef(host)}\0${session.selectionId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function findNativeConversation(db: AppDb, host: HostRef, session: NativeSession) {
  return db
    .select()
    .from(conversationRegistryTable)
    .where(
      and(
        eq(conversationRegistryTable.provider, session.providerId),
        eq(conversationRegistryTable.providerSessionId, session.sessionId),
        eq(conversationRegistryTable.location, host.type === 'remote' ? 'remote' : 'local'),
        host.type === 'remote'
          ? eq(conversationRegistryTable.sshConnectionId, host.id)
          : isNull(conversationRegistryTable.sshConnectionId),
        isNull(conversationRegistryTable.untrackedAt)
      )
    )
    .get();
}

async function bindNativeConversation(
  client: HostRuntimesClient,
  conversationId: string,
  session: NativeSession,
  config: ConversationConfigAcp
): Promise<void> {
  const snapshot = await client.conversations.records.state(undefined, 'list').snapshot();
  const hostRecord = snapshot.data[conversationId];
  if (
    hostRecord &&
    (hostRecord.cwd !== session.cwd ||
      hostRecord.provider !== session.providerId ||
      hostRecord.type !== 'acp')
  )
    throw new Error('The existing conversation cannot be imported with a different identity.');
  const created = await client.conversations.create({
    conversationId,
    provider: session.providerId,
    type: 'acp',
    cwd: session.cwd,
    workspacePath: session.cwd,
    idRegime: 'provider-minted',
    createdAt: hostRecord?.createdAt ?? Date.now(),
    title: session.title,
    config,
  });
  if (!created.success) throw new Error(created.error.message);
  const bound = await client.conversations.reports.providerSessionId({
    conversationId,
    providerSessionId: session.sessionId,
  });
  if (!bound.success) throw new Error(bound.error.message);
}

function registerNativeTask(
  db: AppDb,
  host: HostRef,
  session: NativeSession,
  location: NativeHistoryLocation,
  workspaceId: string,
  config: ConversationConfigAcp
): void {
  const { projectId, taskId, conversationId } = location;
  db.transaction((tx) => {
    tx.insert(tasks)
      .values({
        id: taskId,
        projectId,
        name: session.title,
        status: 'in_progress',
        workspaceId,
        type: 'task',
      })
      .run();
    createConversationRegistry(db).register(
      {
        id: conversationId,
        projectId,
        taskId,
        title: session.title,
        provider: session.providerId,
        type: 'acp',
        config,
        providerSessionId: session.sessionId,
        isInitialConversation: true,
        cwd: session.cwd,
        workspacePath: session.cwd,
        idRegime: 'provider-minted',
        location: host.type === 'remote' ? 'remote' : 'local',
        sshConnectionId: host.type === 'remote' ? host.id : null,
      },
      tx
    );
  });
}
