import { LOCAL_HOST_REF, hostRef } from '@emdash/core/primitives/host/api';
import type { NativeSession } from '@emdash/core/runtimes/acp/api/client';
import type {
  ConversationRecord,
  CreateConversationInput,
} from '@emdash/core/runtimes/conversations/api';
import type { HostRuntimesClient } from '@emdash/core/services/runtime-broker/api';
import { ok, err } from '@emdash/shared';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConversationRegistry } from '../api/node/registry';
import { openNativeHistory } from './native-history';

let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeEach(async () => {
  fixture = await openFixture('empty');
});
afterEach(() => fixture.close());
const session: NativeSession = {
  providerId: 'claude',
  sessionId: 'external-session',
  selectionId: '00000000-0000-4000-8000-000000000000',
  cwd: '/original/subdirectory',
  title: 'Imported task',
  updatedAt: null,
};

function hostClient() {
  const records: Record<string, ConversationRecord> = {};
  const create = vi.fn(async (input: CreateConversationInput) => {
    const prior = records[input.conversationId];
    if (prior && prior.createdAt !== input.createdAt)
      throw new Error('immutable timestamp changed');
    records[input.conversationId] = prior ?? {
      ...input,
      providerSessionId: null,
      providerSessionIdObservedAt: null,
      lastSessionActivityAt: null,
      lastSpawnedAt: null,
      lastResumeOutcome: 'never-resumed',
      updatedAt: 1,
    };
    return ok(records[input.conversationId]);
  });
  const bind = vi.fn(
    async ({
      conversationId,
      providerSessionId,
    }: {
      conversationId: string;
      providerSessionId: string;
    }) => {
      records[conversationId]!.providerSessionId = providerSessionId;
      return ok();
    }
  );
  const workspace = {
    id: 'original-workspace',
    kind: 'directory',
    path: session.cwd,
    parentId: null,
    origin: 'registered',
    gitAdminName: null,
    observedStatus: 'present',
    creation: null,
    lastCreateOutcome: null,
    lifecycle: null,
    lastRemovalAttempt: null,
    git: null,
    lastActivatedAt: null,
    createdAt: 1,
    updatedAt: 1,
    lastObservedAt: 1,
    config: null,
    runtime: null,
  };
  const client = {
    workspaceRegistry: { createWorkspace: vi.fn(async () => ok(workspace)) },
    conversations: {
      create,
      reports: { providerSessionId: bind },
      records: { state: () => ({ snapshot: async () => ({ data: records }) }) },
    },
  };
  return { client: client as unknown as HostRuntimesClient, create, bind };
}

it('registers the original directory and resumes the exact provider ID, without duplicate tasks', async () => {
  const { client, create } = hostClient();
  const first = await openNativeHistory(fixture.db, client, LOCAL_HOST_REF, session);
  const again = await openNativeHistory(fixture.db, client, LOCAL_HOST_REF, session);
  expect(again).toEqual(first);
  expect(create).toHaveBeenCalledOnce();
  expect(createConversationRegistry(fixture.db).getLive(first.conversationId)).toMatchObject({
    providerSessionId: session.sessionId,
    cwd: session.cwd,
    workspacePath: session.cwd,
    config: { version: '1', type: 'acp' },
    projectId: first.projectId,
    taskId: first.taskId,
  });
  expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
});

it('recovers a partial host registration without changing identity or leaving a task', async () => {
  const { client, bind } = hostClient();
  bind.mockResolvedValueOnce(err({ type: 'not-found', message: 'disconnected' }) as never);
  await expect(openNativeHistory(fixture.db, client, LOCAL_HOST_REF, session)).rejects.toThrow(
    'disconnected'
  );
  expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
  await openNativeHistory(fixture.db, client, LOCAL_HOST_REF, session);
  expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
});

it('does not reopen a task whose project is pending deletion', async () => {
  const { client } = hostClient();
  const location = await openNativeHistory(fixture.db, client, LOCAL_HOST_REF, session);
  fixture.sqlite
    .prepare('UPDATE projects SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(location.projectId);
  await expect(openNativeHistory(fixture.db, client, LOCAL_HOST_REF, session)).rejects.toThrow(
    'being deleted'
  );
  expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 1 });
});

it('does not confuse the same provider session ID on two different hosts', async () => {
  fixture.sqlite
    .prepare(
      "INSERT INTO ssh_connections (id, name, host, username) VALUES ('remote', 'Remote', 'test.invalid', 'test')"
    )
    .run();
  const local = hostClient();
  const remote = hostClient();
  vi.mocked(remote.client.workspaceRegistry.createWorkspace).mockResolvedValue(
    ok({
      id: 'remote-workspace',
      kind: 'directory',
      path: session.cwd,
      parentId: null,
      origin: 'registered',
      gitAdminName: null,
      observedStatus: 'present',
      creation: null,
      lastCreateOutcome: null,
      lifecycle: null,
      lastRemovalAttempt: null,
      git: null,
      lastActivatedAt: null,
      createdAt: 1,
      updatedAt: 1,
      lastObservedAt: 1,
      config: null,
      runtime: null,
    })
  );
  const a = await openNativeHistory(fixture.db, local.client, LOCAL_HOST_REF, session);
  const b = await openNativeHistory(
    fixture.db,
    remote.client,
    hostRef('remote', 'remote'),
    session
  );
  expect(a.conversationId).not.toBe(b.conversationId);
  expect(createConversationRegistry(fixture.db).getLive(b.conversationId)).toMatchObject({
    location: 'remote',
    sshConnectionId: 'remote',
    cwd: session.cwd,
  });
});

it('never reuses a removed conversation identity when history is imported again', async () => {
  const { client } = hostClient();
  const first = await openNativeHistory(fixture.db, client, LOCAL_HOST_REF, session);
  createConversationRegistry(fixture.db).untrack([first.conversationId], new Date().toISOString());
  await expect(openNativeHistory(fixture.db, client, LOCAL_HOST_REF, session)).rejects.toThrow(
    'Refresh'
  );
  const refreshed = { ...session, selectionId: '00000000-0000-4000-8000-000000000001' };
  const second = await openNativeHistory(fixture.db, client, LOCAL_HOST_REF, refreshed);
  expect(second.conversationId).not.toBe(first.conversationId);
});
