import type { PromptRequest } from '@agentclientprotocol/sdk';
import { noopLogger } from '@emdash/shared/logger';
import { deferred } from '@emdash/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { FakeAcpAgent } from '../acp-test-support';
import { SessionCell } from './cell';

function fixture() {
  const agent = new FakeAcpAgent();
  const first = deferred<{ stopReason: 'end_turn' }>();
  agent.prompt = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue({ stopReason: 'end_turn' });
  const steerPrompt = vi
    .fn<(request: PromptRequest, priority: 'now' | 'next') => Promise<boolean>>()
    .mockResolvedValue(true);
  const cell = new SessionCell({
    conversationId: 'conv',
    providerId: 'claude',
    acpSessionId: 'session',
    agent: Object.assign(agent, { steerPrompt }),
    logger: noopLogger,
    resolveAttachment: async () => ({ data: 'image', mimeType: 'image/png' }),
  });
  cell.applySessionReady();
  return { cell, agent, steerPrompt, first };
}

describe('Claude running-turn input', () => {
  it.each(['next', 'now'] as const)(
    'injects %s without cancelling or starting another turn',
    async (priority) => {
      const t = fixture();
      const running = t.cell.prompt({ text: 'first' });
      await vi.waitFor(() => expect(t.agent.prompt).toHaveBeenCalledOnce());
      const turnId = t.cell.sessionState.activeTurnId;
      expect(await t.cell.prompt({ text: 'follow up', hiddenContext: 'context' })).toEqual({
        success: true,
        data: { queued: true },
      });
      expect(t.steerPrompt).not.toHaveBeenCalled();
      const id = t.cell.sessionState.queuedPrompts[0].id;
      if (priority === 'next') await t.cell.drainQueuedPrompts();
      else expect((await t.cell.sendQueuedPromptNow(id)).success).toBe(true);
      expect(t.steerPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: [
            { type: 'text', text: 'follow up' },
            { type: 'text', text: expect.stringContaining('context') },
          ],
        }),
        priority
      );
      expect(t.agent.prompt).toHaveBeenCalledOnce();
      expect(t.cell.sessionState.activeTurnId).toBe(turnId);
      expect(t.cell.sessionState.lifecycle).toBe('working');
      expect(t.cell.sessionState.queuedPrompts).toEqual([]);
      t.first.resolve({ stopReason: 'end_turn' });
      await running;
      expect(t.cell.history().committed).toHaveLength(1);
      expect(
        t.cell.history().committed[0].items.filter((item) => item.kind === 'message')
      ).toHaveLength(2);
      t.cell.dispose();
    }
  );

  it('falls back to the normal queue only when the adapter confirms no running turn', async () => {
    const t = fixture();
    const running = t.cell.prompt({ text: 'first' });
    await vi.waitFor(() => expect(t.agent.prompt).toHaveBeenCalledOnce());
    t.steerPrompt.mockResolvedValue(false);
    expect(await t.cell.prompt({ text: 'second' })).toEqual({
      success: true,
      data: { queued: true },
    });
    await t.cell.drainQueuedPrompts();
    t.first.resolve({ stopReason: 'end_turn' });
    await running;
    await vi.waitFor(() => expect(t.agent.prompt).toHaveBeenCalledTimes(2));
    expect(t.steerPrompt).toHaveBeenCalledOnce();
    t.cell.dispose();
  });

  it('does not replay input on a failed steering request', async () => {
    const t = fixture();
    const running = t.cell.prompt({ text: 'first' });
    await vi.waitFor(() => expect(t.agent.prompt).toHaveBeenCalledOnce());
    t.steerPrompt.mockRejectedValue(new Error('connection closed'));
    await t.cell.prompt({ text: 'second' });
    const id = t.cell.sessionState.queuedPrompts[0].id;
    expect((await t.cell.sendQueuedPromptNow(id)).success).toBe(false);
    expect(t.cell.sessionState.queuedPrompts).toEqual([]);
    t.first.resolve({ stopReason: 'end_turn' });
    await running;
    expect(t.agent.prompt).toHaveBeenCalledOnce();
    t.cell.dispose();
  });
});

it('claims a queued message once across double-click and a simultaneous tool boundary', async () => {
  const t = fixture();
  const running = t.cell.prompt({ text: 'first' });
  await vi.waitFor(() => expect(t.agent.prompt).toHaveBeenCalledOnce());
  await t.cell.prompt({ text: 'second' });
  const id = t.cell.sessionState.queuedPrompts[0].id;
  await Promise.all([
    t.cell.sendQueuedPromptNow(id),
    t.cell.sendQueuedPromptNow(id),
    t.cell.drainQueuedPrompts(),
  ]);
  expect(t.steerPrompt).toHaveBeenCalledOnce();
  expect(t.agent.cancel).not.toHaveBeenCalled();
  t.first.resolve({ stopReason: 'end_turn' });
  await running;
  t.cell.dispose();
});

it('buffers output and delays settlement until the supplement receipt arrives', async () => {
  const t = fixture();
  const receipt = deferred<boolean>();
  t.steerPrompt.mockReturnValue(receipt.promise);
  const running = t.cell.prompt({ text: 'first' });
  await vi.waitFor(() => expect(t.agent.prompt).toHaveBeenCalledOnce());
  await t.cell.prompt({ text: 'second' });
  const sending = t.cell.drainQueuedPrompts();
  await vi.waitFor(() => expect(t.steerPrompt).toHaveBeenCalledOnce());
  t.cell.push({ kind: 'message', role: 'assistant', messageId: 'reply', text: 'answer second' });
  t.first.resolve({ stopReason: 'end_turn' });
  await Promise.resolve();
  expect(t.cell.history().committed).toHaveLength(0);
  receipt.resolve(true);
  await Promise.all([sending, running]);
  const messages = t.cell.history().committed[0].items.filter((item) => item.kind === 'message');
  expect(messages.map((item) => item.text)).toEqual(['first', 'second', 'answer second']);
  t.cell.dispose();
});

it('keeps non-supporting agents queued and their Stop behavior unchanged', async () => {
  const t = fixture();
  delete (t.agent as typeof t.agent & { steerPrompt?: unknown }).steerPrompt;
  const running = t.cell.prompt({ text: 'first' });
  await vi.waitFor(() => expect(t.agent.prompt).toHaveBeenCalledOnce());
  await t.cell.prompt({ text: 'second' });
  expect(t.cell.sessionState.canSteer).toBeUndefined();
  await t.cell.drainQueuedPrompts();
  expect(t.steerPrompt).not.toHaveBeenCalled();
  expect(t.cell.sessionState.queuedPrompts).toHaveLength(1);
  await t.cell.cancel();
  expect(t.agent.cancel).toHaveBeenCalledOnce();
  t.first.resolve({ stopReason: 'end_turn' });
  await running;
  await vi.waitFor(() => expect(t.agent.prompt).toHaveBeenCalledTimes(2));
  t.cell.dispose();
});

it('does not send an edited or deleted attachment prompt from an outdated snapshot', async () => {
  const t = fixture();
  const resolving = deferred<{ data: string; mimeType: string }>();
  const cell = new SessionCell({
    conversationId: 'attachments',
    providerId: 'claude',
    acpSessionId: 'session',
    agent: t.agent,
    logger: noopLogger,
    resolveAttachment: () => resolving.promise,
  });
  cell.applySessionReady();
  const running = cell.prompt({ text: 'first' });
  await vi.waitFor(() => expect(t.agent.prompt).toHaveBeenCalledOnce());
  await cell.prompt({
    text: 'image',
    attachments: [{ id: 'file', type: 'attachment', mimeType: 'image/png' }],
  });
  const id = cell.sessionState.queuedPrompts[0].id;
  const sending = cell.sendQueuedPromptNow(id);
  await Promise.resolve();
  cell.removeQueuedPrompt(id);
  resolving.resolve({ data: 'image', mimeType: 'image/png' });
  await sending;
  expect(t.steerPrompt).not.toHaveBeenCalled();
  t.first.resolve({ stopReason: 'end_turn' });
  await running;
  cell.dispose();
  t.cell.dispose();
});

it('keeps FIFO order when the adapter finishes before a batch reaches it', async () => {
  const t = fixture();
  const running = t.cell.prompt({ text: 'first' });
  await vi.waitFor(() => expect(t.agent.prompt).toHaveBeenCalledOnce());
  await t.cell.prompt({ text: 'second' });
  await t.cell.prompt({ text: 'third' });
  t.steerPrompt.mockResolvedValue(false);
  await t.cell.drainQueuedPrompts();
  expect(t.steerPrompt).toHaveBeenCalledOnce();
  expect(t.cell.sessionState.queuedPrompts.map((prompt) => prompt.text)).toEqual([
    'second',
    'third',
  ]);
  t.first.resolve({ stopReason: 'end_turn' });
  await running;
  await vi.waitFor(() => expect(t.agent.prompt).toHaveBeenCalledTimes(3));
  expect(t.agent.prompt.mock.calls.map(([request]) => request.prompt)).toEqual([
    [{ type: 'text', text: 'first' }],
    [{ type: 'text', text: 'second' }],
    [{ type: 'text', text: 'third' }],
  ]);
  t.cell.dispose();
});

it('does not silently consume a queued prompt without a foreground turn', async () => {
  const t = fixture();
  t.cell.queuePrompt({ text: 'retained' }, 'queued');
  expect(await t.cell.sendQueuedPromptNow('queued')).toMatchObject({
    success: false,
    error: { type: 'invalid_state' },
  });
  expect(t.cell.sessionState.queuedPrompts).toHaveLength(1);
  expect(t.steerPrompt).not.toHaveBeenCalled();
  t.cell.dispose();
});
