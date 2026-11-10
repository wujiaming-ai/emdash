import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestWire } from '@emdash/wire/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acpApiContract } from '#runtimes/acp/api';
import { makeAcpHarness, makeStartInput } from '#runtimes/acp/node/acp-test-support';
import { createAcpController } from '#runtimes/acp/node/api/controller';
import { NativeHistory } from './native-history';
import { AcpRuntime } from './runtime';

describe('native history', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'native-history-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(cwd, { recursive: true, force: true });
  });

  function setup() {
    const h = makeAcpHarness();
    const list = vi.fn().mockResolvedValue({
      sessions: [{ sessionId: 'native-id', cwd, title: 'CLI task' }],
      nextCursor: 'next',
    });
    Object.assign(h.agent, { listSessions: list });
    return { h, list, history: new NativeHistory(h.deps) };
  }

  it('reads one native page without creating a session and tears down its reader', async () => {
    const { h, list, history } = setup();
    const page = await history.list({ providerId: 'claude', cursor: 'previous' });
    expect(list).toHaveBeenCalledExactlyOnceWith({
      cursor: 'previous',
      _meta: { 'emdash.dev/history-page-size': 20 },
    });
    expect(page.nextCursor).toBe('next');
    expect(await history.resolve(page.sessions[0]!.selectionId)).toMatchObject({
      cwd,
      sessionId: 'native-id',
    });
    expect(h.agent.newSession).not.toHaveBeenCalled();
    expect(h.fakeHost.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects forged selections, missing directories and expired selections', async () => {
    const { history } = setup();
    await expect(history.resolve('forged')).rejects.toThrow('expired');
    const page = await history.list({ providerId: 'claude' });
    await rm(cwd, { recursive: true });
    await expect(history.resolve(page.sessions[0]!.selectionId)).rejects.toThrow();
    vi.useFakeTimers();
    vi.advanceTimersByTime(31 * 60_000);
    await expect(history.resolve(page.sessions[0]!.selectionId)).rejects.toThrow('expired');
  });

  it('rejects an unbounded adapter page or repeated cursor', async () => {
    const { history, list } = setup();
    list.mockResolvedValueOnce({
      sessions: Array.from({ length: 21 }, (_, i) => ({ cwd, sessionId: String(i) })),
    });
    await expect(history.list({ providerId: 'claude' })).rejects.toThrow('pages');
    await expect(history.list({ providerId: 'claude', cursor: 'next' })).rejects.toThrow(
      'repeated'
    );
  });

  it('invalidates selections and refuses new readers after runtime disposal', async () => {
    const { history } = setup();
    const page = await history.list({ providerId: 'claude' });
    await history.dispose();
    await expect(history.resolve(page.sessions[0]!.selectionId)).rejects.toThrow('expired');
    await expect(history.list({ providerId: 'claude' })).rejects.toThrow('closed');
  });

  it('does not publish a late page after the runtime closes', async () => {
    const { history, list, h } = setup();
    let complete!: (page: { sessions: never[] }) => void;
    const page = new Promise<{ sessions: never[] }>((resolve) => {
      complete = resolve;
    });
    list.mockReturnValue(page);
    const request = history.list({ providerId: 'claude' });
    const rejected = expect(request).rejects.toThrow('ended');
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    await history.dispose();
    complete({ sessions: [] });
    await rejected;
    expect(h.fakeHost.lastHandle.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('round-trips paged discovery and selection resolution through Wire', async () => {
    const { h } = setup();
    const runtime = new AcpRuntime(h.deps);
    const wire = createTestWire(acpApiContract, createAcpController(runtime));
    try {
      const page = await wire.client.nativeHistory.list({ providerId: 'claude' });
      const selectionId = page.sessions[0]!.selectionId;
      await expect(wire.client.nativeHistory.resolve({ selectionId })).resolves.toMatchObject({
        cwd,
        providerId: 'claude',
        sessionId: 'native-id',
      });
      expect(page.nextCursor).toBe('next');
    } finally {
      wire.dispose();
      await runtime.dispose();
    }
  });

  it('cleans up a timed-out reader and does not interrupt an existing conversation', async () => {
    const { h, history, list } = setup();
    const runtime = new AcpRuntime(h.deps);
    await runtime.startSession(makeStartInput(), 'fresh');
    const mainHandle = h.fakeHost.lastHandle;
    list.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const request = history.list({ providerId: 'claude' });
    const rejected = expect(request).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(mainHandle.kill).not.toHaveBeenCalled();
    expect(h.agent.cancel).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('does not replace an imported session when its native history is missing', async () => {
    const h = makeAcpHarness();
    const runtime = new AcpRuntime(h.deps);
    const input = makeStartInput({ sessionId: 'external' });
    h.agent.loadSession.mockRejectedValue(
      Object.assign(new Error('Resource not found'), { code: -32002, data: { uri: 'external' } })
    );
    try {
      const result = await runtime.startSession(input, 'resume');
      expect(result).toMatchObject({ success: false, error: { type: 'session_not_found' } });
      expect(h.agent.newSession).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });
});
