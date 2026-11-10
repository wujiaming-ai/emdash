import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { createScope, type Scope } from '@emdash/shared/concurrency';
import type { NativeHistoryInput, NativeSession } from '#runtimes/acp/api/native-history';
import { createAcpAgentConnection } from '#runtimes/acp/node/connection/acp-agent-connection';
import type { AcpRuntimeDeps } from './types';

/** 主机端的短期选择凭证：桌面只能打开实际列出的记录，不能伪造路径。 */
export class NativeHistory {
  private readonly scope = createScope({ label: 'native-history' });
  private readonly selections = new Map<string, { session: NativeSession; expires: number }>();

  constructor(private readonly deps: Pick<AcpRuntimeDeps, 'agentHost' | 'host' | 'logger'>) {}

  async list(input: NativeHistoryInput) {
    if (this.scope.disposed) throw new Error('The history reader has closed.');
    const scope = this.scope.child('page');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Loading CLI history timed out. Try again.')),
          30_000
        );
      });
      const page = await Promise.race([this.readPage(input, scope), timeout]);
      if (scope.disposed) throw new Error('History request has ended.');
      if (page.sessions.length > 20)
        throw new Error('Update the CLI adapter to browse history in pages.');
      if (page.nextCursor && page.nextCursor === input.cursor)
        throw new Error('The CLI returned a repeated history cursor.');
      this.prune();
      const sessions = page.sessions
        .filter((item) => isAbsolute(item.cwd))
        .map((item) => {
          const session: NativeSession = {
            selectionId: randomUUID(),
            providerId: input.providerId,
            sessionId: item.sessionId,
            cwd: item.cwd,
            title: item.title || 'Untitled conversation',
            updatedAt: item.updatedAt ?? null,
          };
          this.selections.set(session.selectionId, { session, expires: Date.now() + 30 * 60_000 });
          return session;
        });
      return { sessions, nextCursor: page.nextCursor ?? null };
    } finally {
      clearTimeout(timer);
      await scope.dispose();
    }
  }

  async resolve(selectionId: string): Promise<NativeSession> {
    const entry = this.selections.get(selectionId);
    if (!entry || entry.expires < Date.now()) {
      throw new Error('This history selection expired. Refresh the list and try again.');
    }
    const directory = await stat(entry.session.cwd);
    if (!directory.isDirectory())
      throw new Error('The original working directory no longer exists.');
    return entry.session;
  }

  async dispose(): Promise<void> {
    this.selections.clear();
    await this.scope.dispose();
  }

  private prune(): void {
    for (const [id, entry] of this.selections) {
      if (entry.expires < Date.now() || this.selections.size >= 2000) this.selections.delete(id);
    }
  }

  private async readPage(input: NativeHistoryInput, scope: Scope) {
    const binding = this.deps.agentHost.resolveAcp(input.providerId);
    if (!binding) throw new Error('This CLI does not support history browsing.');
    const spawn = await this.deps.agentHost.buildAcpSpawn(input.providerId, {
      cwd: homedir(),
      env: input.env,
    });
    if (!spawn.success) throw new Error('Could not start the CLI history reader.');
    if (scope.disposed) throw new Error('History request has ended.');
    const connection = await createAcpAgentConnection(
      { ...this.deps, behavior: binding.behavior },
      {
        providerId: input.providerId,
        spawn: spawn.data,
        scope,
        buildClient: () => ({
          sessionUpdate: async () => {},
          requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        }),
        onClosed: () => {},
      }
    );
    if (!connection.success) throw new Error('Could not initialize the CLI history reader.');
    const agent = connection.data.agent;
    if (!agent.listSessions) throw new Error('This CLI does not support history browsing.');
    return agent.listSessions({
      cursor: input.cursor,
      _meta: { 'emdash.dev/history-page-size': 20 },
    });
  }
}
