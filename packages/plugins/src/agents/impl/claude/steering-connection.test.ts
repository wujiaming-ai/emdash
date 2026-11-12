import type { AcpProcessIo } from '@emdash/core/services/agent-plugins/api/plugins';
import { beforeEach, expect, it, vi } from 'vitest';
import { connectClaudeAcp } from './steering';

const mocks = vi.hoisted(() => ({ initialize: vi.fn(), extMethod: vi.fn() }));
vi.mock('../../helpers/acp-stdio', () => ({
  connectStdioAcp: () => ({ initialize: mocks.initialize, extMethod: mocks.extMethod }),
}));
beforeEach(() => vi.resetAllMocks());

it.each([undefined, { supported: true }, { supported: true, priorities: ['now'] }])(
  'leaves legacy adapters without running-turn capability (%j)',
  async (steering) => {
    mocks.initialize.mockResolvedValue({ protocolVersion: 1, _meta: { steering } });
    const agent = connectClaudeAcp({} as AcpProcessIo, () => ({}) as never);
    await agent.initialize({ protocolVersion: 1 });
    expect(agent.steerPrompt).toBeUndefined();
  }
);

it('advertises the reverse boundary handler and requests host-owned fallback', async () => {
  mocks.initialize.mockResolvedValue({
    protocolVersion: 1,
    _meta: { steering: { supported: true, priorities: ['now', 'next'] } },
  });
  const agent = connectClaudeAcp({} as AcpProcessIo, () => ({}) as never);
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true } },
  });
  expect(mocks.initialize).toHaveBeenCalledWith({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true },
      _meta: { 'emdash.dev/queued-steering': true, 'emdash.dev/activities': 1 },
    },
  });
  mocks.extMethod.mockResolvedValue({ outcome: 'injected' });
  const request = { sessionId: 's', prompt: [{ type: 'text' as const, text: 'follow up' }] };
  expect(await agent.steerPrompt!(request, 'next')).toBe(true);
  expect(mocks.extMethod).toHaveBeenCalledWith('_session/steering', {
    ...request,
    _meta: { steering: { idleBehavior: 'promptRequired', priority: 'next' } },
  });
  mocks.extMethod.mockResolvedValue({ outcome: 'promptRequired' });
  expect(await agent.steerPrompt!(request, 'now')).toBe(false);
  mocks.extMethod.mockResolvedValue({ outcome: 'startedNewTurn' });
  await expect(agent.steerPrompt!(request, 'now')).rejects.toThrow(
    'Unexpected Claude steering response'
  );
});

it.each([undefined, 1])(
  'negotiates native activities independently of steering (%s)',
  async (capability) => {
    mocks.initialize.mockResolvedValue({
      protocolVersion: 1,
      _meta: { 'emdash.dev/activities': capability },
    });
    const agent = connectClaudeAcp({} as AcpProcessIo, () => ({}) as never);
    await agent.initialize({ protocolVersion: 1 });
    expect(agent.supportsActivities).toBe(capability === 1);
  }
);
