import { ClaudeAcpAgent } from '@agentclientprotocol/claude-agent-acp/dist/acp-agent.js';
import { describe, expect, it, vi } from 'vitest';

type Client = ConstructorParameters<typeof ClaudeAcpAgent>[0];
type Session = ClaudeAcpAgent['sessions'][string];
function fixture(pendingUserInputCount = 0) {
  const client = { sessionUpdate: vi.fn().mockResolvedValue(undefined) } as unknown as Client;
  const agent = new ClaudeAcpAgent(client);
  const input = { push: vi.fn() };
  const turn = { settled: false };
  agent.sessions.test = { input, turnQueue: [turn], pendingUserInputCount } as unknown as Session;
  return { agent, input, turn };
}

describe('patched Claude steering', () => {
  it.each(['now', 'next'] as const)(
    'injects explicit priority %s into the SDK stream',
    async (priority) => {
      const { agent, input, turn } = fixture();
      expect(
        await agent.steer({
          sessionId: 'test',
          prompt: [{ type: 'text', text: 'hello' }],
          _meta: { steering: { priority, idleBehavior: 'promptRequired' } },
        })
      ).toEqual({ outcome: 'injected' });
      expect(input.push).toHaveBeenCalledWith(
        expect.objectContaining({
          priority,
          message: expect.objectContaining({
            content: expect.arrayContaining([expect.objectContaining({ text: 'hello' })]),
          }),
        })
      );
      expect(turn).toMatchObject({ steeredEchoes: expect.any(Set) });
      expect(agent.sessions.test.turnQueue).toHaveLength(1);
    }
  );
  it('does not cancel a pending permission or elicitation callback', async () => {
    const { agent, input } = fixture(1);
    await agent.steer({
      sessionId: 'test',
      prompt: [{ type: 'text', text: 'hello' }],
      _meta: { steering: { priority: 'now' } },
    });
    expect(input.push).toHaveBeenCalledWith(expect.objectContaining({ priority: 'later' }));
  });
  it('returns a no-send result after the active turn has finished', async () => {
    const { agent, input } = fixture();
    agent.sessions.test.turnQueue = [];
    expect(
      await agent.steer({
        sessionId: 'test',
        prompt: [{ type: 'text', text: 'hello' }],
        _meta: { steering: { priority: 'now', idleBehavior: 'promptRequired' } },
      })
    ).toEqual({ outcome: 'promptRequired', reason: 'noRunningTurn' });
    expect(input.push).not.toHaveBeenCalled();
  });
});
