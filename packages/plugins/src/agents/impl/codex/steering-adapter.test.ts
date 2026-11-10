import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const source = readFileSync(
  process.env.EMDASH_TEST_CODEX_ADAPTER ?? require.resolve('@agentclientprotocol/codex-acp'),
  'utf8'
);
type Prompt = {
  sessionId: string;
  prompt: { type: string; text: string }[];
  _meta?: { steering: { idleBehavior: string } };
};
type Outcome = { outcome: string };

function fixture(turnId: string | null = 'running') {
  // 执行实际发布 adapter 中的这两个方法，替换的只有 Codex 进程 IO 边界。
  const method = (name: string, end: string): string => {
    const start = source.indexOf(`  ${name}`);
    expect(start).toBeGreaterThan(0);
    const stop = source.indexOf(end, start);
    expect(stop).toBeGreaterThan(start);
    return source.slice(start, stop).trim();
  };
  const methods = vm.runInNewContext(
    `({ ${method('async performSteeringRequest(params)', '\n  /**')}, ${method('parseSessionSteerParams(params)', '\n  createSessionConfigOptions(')} })`,
    {
      logger: { log: () => undefined },
      RequestError: { invalidParams: () => new Error('invalid params') },
    }
  ) as {
    performSteeringRequest(params: Prompt): Promise<Outcome>;
    parseSessionSteerParams(params: Prompt): Prompt;
  };
  const agent = Object.assign(methods, {
    getSessionState: vi.fn().mockReturnValue({}),
    assertSteerInputSupported: vi.fn(),
    getSteerableTurnId: vi.fn().mockResolvedValue(turnId),
    injectSteerIntoActiveTurn: vi.fn().mockResolvedValue(true),
    startNewTurnFromSteering: vi.fn().mockResolvedValue({ outcome: 'startedNewTurn' }),
  });
  const input: Prompt = {
    sessionId: 'session',
    prompt: [{ type: 'text', text: 'supplement' }],
    _meta: { steering: { idleBehavior: 'promptRequired' } },
  };
  return { agent, input };
}

describe('packaged Codex steering ownership', () => {
  it('preserves the idle policy across ACP parameter parsing', () => {
    const { agent, input } = fixture();
    expect(agent.parseSessionSteerParams(input)).toEqual(input);
  });
  it.each(['idle', 'turn-finished-during-injection'])(
    'returns ownership to Emdash when %s',
    async (state) => {
      const { agent, input } = fixture(state === 'idle' ? null : 'running');
      agent.injectSteerIntoActiveTurn.mockResolvedValue(false);
      expect(await agent.performSteeringRequest(input)).toEqual({ outcome: 'promptRequired' });
      expect(agent.startNewTurnFromSteering).not.toHaveBeenCalled();
    }
  );
  it('injects into a running turn without starting another one', async () => {
    const { agent, input } = fixture();
    expect(await agent.performSteeringRequest(input)).toEqual({ outcome: 'injected' });
    expect(agent.injectSteerIntoActiveTurn).toHaveBeenCalledWith(input, 'running', {});
    expect(agent.startNewTurnFromSteering).not.toHaveBeenCalled();
  });
  it('preserves the upstream idle behavior for clients without the opt-in', async () => {
    const { agent, input } = fixture(null);
    delete input._meta;
    expect(await agent.performSteeringRequest(input)).toEqual({ outcome: 'startedNewTurn' });
  });
});
