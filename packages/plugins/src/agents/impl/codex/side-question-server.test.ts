import { randomUUID } from 'node:crypto';
import { deferred } from '@emdash/shared/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexSideQuestions, type SideQuestionClient } from './side-question-server';

function harness() {
  let notify: ((event: unknown) => void) | undefined;
  const client = {
    configRead: vi.fn().mockResolvedValue({ config: { mcp_servers: { 'team.tools': {} } } }),
    threadReadWithHistory: vi
      .fn()
      .mockResolvedValue({ thread: { turns: [{ id: 'working', status: 'inProgress' }] } }),
    threadFork: vi.fn().mockResolvedValue({ thread: { id: 'child', ephemeral: true } }),
    getThreadSettings: vi.fn().mockReturnValue({ model: 'custom-model', modelProvider: 'gateway' }),
    turnStart: vi.fn().mockResolvedValue({ turn: { id: 'child-turn' } }),
    turnInterrupt: vi.fn().mockResolvedValue({}),
    threadUnsubscribe: vi.fn().mockResolvedValue({}),
    threadArchive: vi.fn().mockResolvedValue({}),
    onServerNotification: vi.fn((_id: string, cb: (event: unknown) => void) => {
      notify = cb;
    }),
    clearThreadHandlers: vi.fn(),
  } satisfies SideQuestionClient;
  const service = new CodexSideQuestions(client);
  const sideId = randomUUID();
  const ask = (question = 'Explain this') =>
    service.request('parent', '/work', {}, { sideId, action: 'ask', question, quote: 'reference' });
  const action = (action: 'cancel' | 'close') =>
    service.request('parent', '/work', {}, { sideId, action });
  const finish = () => {
    notify?.({ method: 'item/agentMessage/delta', params: { delta: 'Answer' } });
    notify?.({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  };
  return { client, service, sideId, ask, action, finish };
}
afterEach(() => vi.useRealTimers());

it('forks completed main context with custom model, disables tools, and retains follow-up history', async () => {
  const h = harness();
  const first = h.ask();
  await vi.waitFor(() => expect(h.client.turnStart).toHaveBeenCalled());
  expect(h.client.threadFork).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: 'parent',
      ephemeral: true,
      beforeTurnId: 'working',
      model: 'custom-model',
      modelProvider: 'gateway',
      sandbox: 'read-only',
      config: expect.objectContaining({
        'features.shell_tool': false,
        mcp_servers: { 'team.tools': { enabled: false } },
      }),
    })
  );
  expect(h.client.turnStart).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: 'child', environments: [], approvalPolicy: 'never' })
  );
  h.finish();
  await expect(first).resolves.toEqual({ text: 'Answer' });
  const next = h.ask('And why?');
  await vi.waitFor(() => expect(h.client.turnStart).toHaveBeenCalledTimes(2));
  h.finish();
  await next;
  expect(h.client.threadFork).toHaveBeenCalledTimes(1);
  await h.action('close');
  expect(h.client.threadUnsubscribe).toHaveBeenCalledExactlyOnceWith({ threadId: 'child' });
  expect(h.client.turnInterrupt).not.toHaveBeenCalled();
});

it('cancels only the child turn and allows another question', async () => {
  const h = harness();
  const pending = h.ask();
  const rejected = expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(h.client.turnStart).toHaveBeenCalled());
  await h.action('cancel');
  await rejected;
  expect(h.client.turnInterrupt).toHaveBeenCalledExactlyOnceWith({
    threadId: 'child',
    turnId: 'child-turn',
  });
  const next = h.ask();
  await vi.waitFor(() => expect(h.client.turnStart).toHaveBeenCalledTimes(2));
  h.finish();
  await next;
  await h.action('close');
});

it('handles cancellation before the turn-start acknowledgement without starting an overlapping question', async () => {
  const h = harness();
  const start = deferred<{ turn: { id: string } }>();
  h.client.turnStart.mockReturnValueOnce(start.promise);
  const pending = h.ask();
  const rejected = expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(h.client.turnStart).toHaveBeenCalled());
  const cancelling = h.action('cancel');
  await expect(h.ask()).rejects.toThrow('already running');
  start.resolve({ turn: { id: 'late-turn' } });
  await cancelling;
  await rejected;
  expect(h.client.turnInterrupt).toHaveBeenCalledExactlyOnceWith({
    threadId: 'child',
    turnId: 'late-turn',
  });
  await h.action('close');
});

it('cleans up exactly once when closed during a pending fork', async () => {
  const h = harness();
  const fork = deferred<{ thread: { id: string; ephemeral: boolean } }>();
  h.client.threadFork.mockReturnValueOnce(fork.promise);
  const pending = h.ask();
  const rejected = expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(h.client.threadFork).toHaveBeenCalled());
  const closing = h.action('close');
  fork.resolve({ thread: { id: 'child', ephemeral: true } });
  await closing;
  await rejected;
  expect(h.client.turnStart).not.toHaveBeenCalled();
  expect(h.client.threadUnsubscribe).toHaveBeenCalledExactlyOnceWith({ threadId: 'child' });
});

it('fails closed on unsupported ephemeral forks and archives only the new child', async () => {
  const h = harness();
  h.client.threadFork.mockResolvedValue({ thread: { id: 'child', ephemeral: false } });
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(h.ask()).rejects.toThrow('Update Codex');
  expect(h.client.turnStart).not.toHaveBeenCalled();
  expect(h.client.threadArchive).toHaveBeenCalledExactlyOnceWith({ threadId: 'child' });
  warning.mockRestore();
});

it('rejects malformed input and stale controls without affecting the current side', async () => {
  const h = harness();
  await expect(
    h.service.request('parent', '/work', {}, { sideId: h.sideId, action: 'ask', question: ' ' })
  ).rejects.toThrow();
  expect(h.client.threadFork).not.toHaveBeenCalled();
  const pending = h.ask();
  await vi.waitFor(() => expect(h.client.turnStart).toHaveBeenCalled());
  await h.service.request('parent', '/work', {}, { sideId: randomUUID(), action: 'cancel' });
  expect(h.client.turnInterrupt).not.toHaveBeenCalled();
  h.finish();
  await pending;
  await h.service.closeParent('parent');
});

it('times out and releases the child without cancelling the main turn', async () => {
  vi.useFakeTimers();
  const h = harness();
  const pending = h.ask();
  const rejected = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(180_001);
  await rejected;
  expect(h.client.threadUnsubscribe).toHaveBeenCalledExactlyOnceWith({ threadId: 'child' });
  expect(h.client.turnInterrupt).toHaveBeenCalledExactlyOnceWith({
    threadId: 'child',
    turnId: 'child-turn',
  });
});

it('releases a running child even when interruption fails', async () => {
  const h = harness();
  const pending = h.ask();
  const rejected = expect(pending).rejects.toThrow('closed');
  await vi.waitFor(() => expect(h.client.turnStart).toHaveBeenCalled());
  h.client.turnInterrupt.mockRejectedValueOnce(new Error('Disconnected'));
  await expect(h.action('close')).rejects.toThrow('Disconnected');
  await rejected;
  expect(h.client.threadUnsubscribe).toHaveBeenCalledExactlyOnceWith({ threadId: 'child' });
});

it('releases a fork arriving after its deadline without ever starting a side turn', async () => {
  vi.useFakeTimers();
  const h = harness();
  const fork = deferred<{ thread: { id: string; ephemeral: boolean } }>();
  h.client.threadFork.mockReturnValueOnce(fork.promise);
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
  const rejected = expect(h.ask()).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(15_001);
  await rejected;
  fork.resolve({ thread: { id: 'late-child', ephemeral: true } });
  await vi.advanceTimersByTimeAsync(1);
  expect(h.client.turnStart).not.toHaveBeenCalled();
  expect(h.client.threadUnsubscribe).toHaveBeenCalledExactlyOnceWith({ threadId: 'late-child' });
  warning.mockRestore();
});
