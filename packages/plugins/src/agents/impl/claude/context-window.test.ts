import { ContextWindowTracker } from '@agentclientprotocol/claude-agent-acp/dist/context-window.js';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { Query, SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

type UsageUpdate = Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>;

function fixture() {
  const logger = { error: vi.fn() };
  const tracker = new ContextWindowTracker(logger, 100);
  const getContextUsage = vi.fn<Query['getContextUsage']>();
  const publish = vi.fn<(update: UsageUpdate) => Promise<void>>().mockResolvedValue(undefined);
  const usage: UsageUpdate = {
    sessionUpdate: 'usage_update',
    used: 745000,
    size: 200000,
    cost: { amount: 2, currency: 'USD' },
    _meta: { '_claude/model': 'custom/backend' },
  };
  const refresh = (isCurrent = () => true): Promise<void> =>
    tracker.refresh({ getContextUsage }, isCurrent, publish);
  return { tracker, getContextUsage, publish, usage, logger, refresh };
}

function summary(rawMaxTokens = 1000000, totalTokens = 745000): SDKControlGetContextUsageResponse {
  return { rawMaxTokens, totalTokens } as SDKControlGetContextUsageResponse;
}

function deferredSummary(): {
  promise: Promise<SDKControlGetContextUsageResponse>;
  resolve: (value: SDKControlGetContextUsageResponse) => void;
} {
  let resolve!: (value: SDKControlGetContextUsageResponse) => void;
  const promise = new Promise<SDKControlGetContextUsageResponse>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe('Claude context window compatibility patch', () => {
  it('does not turn the adapter default into a known window or probe an unstarted session', async () => {
    const test = fixture();
    await test.refresh();
    expect(test.getContextUsage).not.toHaveBeenCalled();
    expect(test.tracker.decorate(test.usage, false)).toMatchObject({
      size: 0,
      used: 745000,
      _meta: { 'emdash.dev/context-window': 'unknown' },
    });
  });

  it('replaces a 200k SDK estimate with the CLI policy window, preserving cost and model metadata', async () => {
    const test = fixture();
    expect(test.tracker.decorate(test.usage, true)._meta).toMatchObject({
      'emdash.dev/context-window': 'estimated',
    });
    test.getContextUsage.mockResolvedValue(summary());
    await test.refresh();
    expect(test.getContextUsage).toHaveBeenCalledWith({ detail: 'summary' });
    expect(test.publish).toHaveBeenCalledWith({
      ...test.usage,
      size: 1000000,
      _meta: { '_claude/model': 'custom/backend', 'emdash.dev/context-window': 'resolved' },
    });
    // 压缩后立即保留 post_tokens，新一轮的 SDK 模型容量不能覆盖压缩策略窗口。
    expect(test.tracker.decorate({ ...test.usage, used: 18000 }, true)).toMatchObject({
      used: 18000,
      size: 1000000,
    });
  });

  it('accepts a smaller policy window rather than treating it as model capacity', async () => {
    const test = fixture();
    test.tracker.decorate({ ...test.usage, size: 1000000 }, true);
    test.getContextUsage.mockResolvedValue(summary(200000, 18000));
    await test.refresh();
    expect(test.publish).toHaveBeenCalledWith(
      expect.objectContaining({ size: 200000, used: 18000 })
    );
  });

  it.each(['prompt', 'model', 'usage', 'closed'] as const)(
    'discards an in-flight summary after %s changes',
    async (change) => {
      const test = fixture();
      const deferred = deferredSummary();
      test.getContextUsage.mockReturnValue(deferred.promise);
      test.tracker.decorate(test.usage, true);
      let current = true;
      const pending = test.refresh(() => current);
      if (change === 'closed') current = false;
      else if (change === 'usage') test.tracker.decorate({ ...test.usage, used: 18000 }, true);
      else test.tracker.invalidate(change === 'model');
      deferred.resolve(summary());
      await pending;
      expect(test.publish).not.toHaveBeenCalled();
    }
  );

  it('does not carry a resolved policy window across a model switch', async () => {
    const test = fixture();
    test.tracker.decorate(test.usage, true);
    test.getContextUsage.mockResolvedValue(summary());
    await test.refresh();
    test.tracker.invalidate(true);
    expect(test.tracker.decorate(test.usage, false)).toMatchObject({
      size: 0,
      _meta: { 'emdash.dev/context-window': 'unknown' },
    });
  });

  it('bounds waiting, prevents request buildup, ignores late responses and can recover', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const deferred = deferredSummary();
    test.tracker.decorate(test.usage, true);
    test.getContextUsage.mockReturnValueOnce(deferred.promise).mockResolvedValue(summary());
    const pending = test.refresh();
    await test.refresh();
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    await test.refresh();
    expect(test.getContextUsage).toHaveBeenCalledTimes(1);
    expect(test.logger.error).toHaveBeenCalledOnce();
    deferred.resolve(summary());
    await vi.advanceTimersByTimeAsync(0);
    expect(test.publish).not.toHaveBeenCalled();
    await test.refresh();
    expect(test.publish).toHaveBeenCalledOnce();
  });

  it.each([summary(0), summary(NaN), summary(1000000, -1)])(
    'rejects invalid summaries',
    async (value) => {
      const test = fixture();
      test.tracker.decorate(test.usage, true);
      test.getContextUsage.mockResolvedValue(value);
      await test.refresh();
      expect(test.publish).not.toHaveBeenCalled();
      expect(test.logger.error).toHaveBeenCalledOnce();
    }
  );

  it('handles unsupported SDK requests and publication failure without leaking backend errors', async () => {
    const test = fixture();
    test.tracker.decorate(test.usage, true);
    test.getContextUsage
      .mockRejectedValueOnce(new Error('private backend detail'))
      .mockResolvedValue(summary());
    await test.refresh();
    test.publish.mockRejectedValueOnce(new Error('transport closed'));
    await test.refresh();
    expect(test.logger.error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(test.logger.error.mock.calls)).not.toContain('private backend detail');
  });
});
