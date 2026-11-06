import { randomUUID } from 'node:crypto';
import { deferred } from '@emdash/shared/testing';
import { peek } from '@emdash/wire/state';
import { createTestWire } from '@emdash/wire/testing';
import { expect, it, vi } from 'vitest';
import { createRecordingConversationLifecycleReporter } from '#services/conversation-reports/node/testing';
import { acpApiContract } from '../../api';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { createAcpController } from '../api/controller';
import { AcpRuntime } from './runtime';

it('uses the normal prompt/config/attachment APIs for an isolated temporary fork', async () => {
  const h = makeAcpHarness();
  const reports = createRecordingConversationLifecycleReporter();
  h.deps.conversationReports = reports;
  const fork = vi.fn().mockResolvedValue({
    sessionId: 'side-native',
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'a',
        options: [
          { value: 'a', name: 'A' },
          { value: 'b', name: 'B' },
        ],
      },
    ],
  });
  Object.assign(h.agent, { forkSideSession: fork });
  const mainTurn = deferred<{ stopReason: 'end_turn' }>();
  h.agent.prompt.mockReturnValueOnce(mainTurn.promise);
  const runtime = new AcpRuntime(h.deps);
  const wire = createTestWire(acpApiContract, createAcpController(runtime));
  try {
    const parent = makeStartInput({ conversationId: 'parent' });
    expect((await wire.client.startSession({ ...parent, mode: 'fresh' })).success).toBe(true);
    await wire.client.sendPrompt({
      conversationId: 'parent',
      promptId: randomUUID(),
      prompt: { text: 'main task' },
    });
    const input = { ...parent, conversationId: 'side', sideParentConversationId: 'parent' };
    expect(await wire.client.startSession({ ...input, mode: 'fresh' })).toMatchObject({
      success: true,
      data: { sessionId: 'side-native' },
    });
    expect(fork).toHaveBeenCalledWith({ cwd: parent.cwd, sessionId: 'session-1', mcpServers: [] });
    expect(h.agent.newSession).toHaveBeenCalledTimes(1);
    expect(
      (await wire.client.setOption({ conversationId: 'side', configId: 'model', value: 'b' }))
        .success
    ).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'side-native', value: 'b' })
    );
    await wire.client.sendPrompt({
      conversationId: 'side',
      promptId: randomUUID(),
      prompt: {
        text: 'side question',
        attachments: [{ type: 'attachment', id: 'upload', mimeType: 'image/png' }],
      },
    });
    expect(h.deps.resolveAttachment).toHaveBeenCalledWith(
      'parent',
      expect.objectContaining({ id: 'upload' })
    );
    expect(h.agent.prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'side-native' })
    );
    expect(h.agent.cancel).not.toHaveBeenCalled();
    expect(peek(runtime.sessionsListLiveModel().states.list)).not.toHaveProperty('side');
    expect(await h.deps.intents.list()).toMatchObject({
      success: true,
      data: [expect.objectContaining({ conversationId: 'parent' })],
    });
    expect(reports.started.map((item) => item.conversationId)).toEqual(['parent']);
    expect(reports.activities).not.toContain('side');
    const main = await wire.client.loadHistory({ conversationId: 'parent', limit: 100 });
    expect(JSON.stringify(main)).not.toContain('side question');
    await wire.client.terminate({ conversationId: 'side' });
    expect(h.agent.closeSession).toHaveBeenCalledWith({ sessionId: 'side-native' });
    expect(h.agent.cancel).not.toHaveBeenCalledWith({ sessionId: 'session-1' });
  } finally {
    mainTurn.resolve({ stopReason: 'end_turn' });
    wire.dispose();
    await runtime.dispose();
  }
});

it('rejects unsupported or mismatched parent processes instead of creating a normal session', async () => {
  const h = makeAcpHarness();
  const runtime = new AcpRuntime(h.deps);
  const parent = makeStartInput({ conversationId: 'parent' });
  try {
    await runtime.startSession(parent, 'fresh');
    const side = { ...parent, conversationId: 'side', sideParentConversationId: 'parent' };
    expect((await runtime.startSession(side, 'fresh')).success).toBe(false);
    expect(h.agent.newSession).toHaveBeenCalledTimes(1);
    const fork = vi.fn().mockResolvedValue({ sessionId: 'side-native' });
    Object.assign(h.agent, { forkSideSession: fork });
    expect(
      (await runtime.startSession({ ...side, conversationId: 'wrong', cwd: '/other' }, 'fresh'))
        .success
    ).toBe(false);
    expect(fork).not.toHaveBeenCalled();
  } finally {
    await runtime.dispose();
  }
});

it('closes a late fork and never resumes a suspended temporary session from disk', async () => {
  const h = makeAcpHarness();
  const pending = deferred<{ sessionId: string }>();
  const fork = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ sessionId: 'second-side' });
  Object.assign(h.agent, { forkSideSession: fork });
  const runtime = new AcpRuntime(h.deps);
  const wire = createTestWire(acpApiContract, createAcpController(runtime));
  try {
    const parent = makeStartInput({ conversationId: 'parent' });
    await wire.client.startSession({ ...parent, mode: 'fresh' });
    const side = { ...parent, conversationId: 'late-side', sideParentConversationId: 'parent' };
    const starting = wire.client.startSession({ ...side, mode: 'fresh' });
    await vi.waitFor(() => expect(fork).toHaveBeenCalledOnce());
    await wire.client.terminate({ conversationId: side.conversationId });
    pending.resolve({ sessionId: 'late-native' });
    expect((await starting).success).toBe(false);
    await vi.waitFor(() =>
      expect(h.agent.closeSession).toHaveBeenCalledWith({ sessionId: 'late-native' })
    );
    const started = await wire.client.startSession({
      ...side,
      conversationId: 'side-two',
      mode: 'fresh',
    });
    expect(started.success).toBe(true);
    await wire.client.terminate({ conversationId: 'parent' });
    expect(h.agent.closeSession).toHaveBeenCalledWith({ sessionId: 'second-side' });
    expect(peek(runtime.sessionsListLiveModel().states.list)).not.toHaveProperty('side-two');
  } finally {
    pending.resolve({ sessionId: 'late-native' });
    wire.dispose();
    await runtime.dispose();
  }
});

it('does not resume temporary history after the native session has stopped', async () => {
  const h = makeAcpHarness();
  const fork = vi.fn().mockResolvedValue({ sessionId: 'side-native' });
  Object.assign(h.agent, { forkSideSession: fork });
  const runtime = new AcpRuntime(h.deps);
  const parent = makeStartInput({ conversationId: 'parent' });
  const side = { ...parent, conversationId: 'side', sideParentConversationId: 'parent' };
  try {
    await runtime.startSession(parent, 'fresh');
    expect((await runtime.startSession(side, 'fresh')).success).toBe(true);
    await runtime.stopSession('side');
    expect((await runtime.startSession(side, 'resume')).success).toBe(false);
    expect(fork).toHaveBeenCalledOnce();
    expect(h.agent.loadSession).not.toHaveBeenCalled();
  } finally {
    await runtime.dispose();
  }
});
