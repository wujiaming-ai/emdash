import { ContextWindowTracker } from '@agentclientprotocol/claude-agent-acp/dist/context-window.js';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, expect, it, vi } from 'vitest';

type Usage = Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>;
const summary = { rawMaxTokens: 250000, totalTokens: 0 } as SDKControlGetContextUsageResponse;
function fixture() {
  let resolve!: (value: SDKControlGetContextUsageResponse) => void;
  const request = new Promise<SDKControlGetContextUsageResponse>((done) => {
    resolve = done;
  });
  const query = { getContextUsage: vi.fn(() => request) };
  const logger = { error: vi.fn() };
  const tracker = new ContextWindowTracker(logger, 100);
  const publish = vi.fn<(usage: Usage) => Promise<void>>().mockResolvedValue(undefined);
  return { tracker, query, publish, resolve, logger };
}
afterEach(() => vi.useRealTimers());

it('queries a fresh initialized session without a first prompt or usage update', async () => {
  const t = fixture();
  const pending = t.tracker.initialize(t.query, () => true, t.publish, true);
  t.resolve(summary);
  await pending;
  expect(t.query.getContextUsage).toHaveBeenCalledWith({ detail: 'summary' });
  expect(t.publish).toHaveBeenCalledWith({
    sessionUpdate: 'usage_update',
    used: 0,
    size: 250000,
    _meta: { 'emdash.dev/context-window': 'resolved' },
  });
});

it('does not publish a zero token count while resuming without replayed usage', async () => {
  const t = fixture();
  const pending = t.tracker.initialize(t.query, () => true, t.publish, false);
  t.resolve(summary);
  await pending;
  expect(t.publish).not.toHaveBeenCalled();
  expect(
    t.tracker.decorate({ sessionUpdate: 'usage_update', used: 75000, size: 0 }, false)
  ).toMatchObject({
    used: 75000,
    size: 250000,
    _meta: { 'emdash.dev/context-window': 'resolved' },
  });
});

it('keeps newer prompt, replay and compaction usage while the startup query is in flight', async () => {
  const t = fixture();
  const pending = t.tracker.initialize(t.query, () => true, t.publish, false);
  t.tracker.invalidate();
  const usage: Usage = {
    sessionUpdate: 'usage_update',
    used: 18000,
    size: 0,
    cost: { amount: 2, currency: 'USD' },
    _meta: { '_claude/model': 'custom/backend' },
  };
  t.tracker.decorate(usage, false);
  t.resolve(summary);
  await pending;
  expect(t.publish).toHaveBeenCalledWith({
    ...usage,
    size: 250000,
    _meta: { ...usage._meta, 'emdash.dev/context-window': 'resolved' },
  });
});

it.each(['model', 'closed'] as const)(
  'rejects startup results after %s changes',
  async (change) => {
    const t = fixture();
    let current = true;
    const pending = t.tracker.initialize(t.query, () => current, t.publish, true);
    if (change === 'model') t.tracker.invalidate(true);
    else current = false;
    t.resolve(summary);
    await pending;
    expect(t.publish).not.toHaveBeenCalled();
  }
);

it('bounds startup waiting without overlapping requests and permits post-result recovery', async () => {
  vi.useFakeTimers();
  const t = fixture();
  const pending = t.tracker.initialize(t.query, () => true, t.publish, true);
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  await t.tracker.refresh(t.query, () => true, t.publish);
  expect(t.query.getContextUsage).toHaveBeenCalledTimes(1);
  t.resolve(summary);
  await vi.advanceTimersByTimeAsync(0);
  expect(t.publish).not.toHaveBeenCalled();
  t.tracker.decorate({ sessionUpdate: 'usage_update', used: 500, size: 0 }, false);
  t.query.getContextUsage.mockResolvedValue({ ...summary, totalTokens: 500 });
  await t.tracker.refresh(t.query, () => true, t.publish);
  expect(t.publish).toHaveBeenCalledWith(expect.objectContaining({ used: 500, size: 250000 }));
  expect(t.logger.error).toHaveBeenCalledOnce();
});
