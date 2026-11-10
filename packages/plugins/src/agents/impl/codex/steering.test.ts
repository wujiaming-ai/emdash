import { PassThrough } from 'node:stream';
import type { AcpAgentApi } from '@emdash/core/services/agent-plugins/api/plugins';
import { deferred } from '@emdash/shared/testing';
import { expect, it, vi } from 'vitest';
import { connectCodexAcp } from './side-question';
import { enableCodexSteering } from './steering';

it.each([undefined, 1])('negotiates safe running-turn input (%s)', async (capability) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const requests: { method: string; params: unknown }[] = [];
  let outcome = 'injected';
  stdin.on('data', (data: Buffer) => {
    const request = JSON.parse(data.toString());
    if (!('id' in request)) return;
    requests.push(request);
    stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result:
          request.method === 'initialize'
            ? {
                protocolVersion: 1,
                agentCapabilities: {},
                authMethods: [],
                _meta: {
                  steering: { supported: true },
                  'emdash.dev/running-turn-input': capability,
                },
              }
            : { outcome },
      }) + '\n'
    );
  });
  const agent = connectCodexAcp({ stdin, stdout }, () => ({
    sessionUpdate: vi.fn(),
    requestPermission: vi.fn(),
  }));
  try {
    await agent.initialize({ protocolVersion: 1 });
    if (capability !== 1) {
      expect(agent.steerPrompt).toBeUndefined();
      return;
    }
    expect(agent.steerPrompt).toBeTypeOf('function');
    const prompt = { sessionId: 'main', prompt: [{ type: 'text' as const, text: 'supplement' }] };
    expect(await agent.steerPrompt!(prompt, 'next')).toBe(true);
    expect(requests.at(-1)).toMatchObject({
      method: '_session/steering',
      params: { ...prompt, _meta: { steering: { idleBehavior: 'promptRequired' } } },
    });
    outcome = 'promptRequired';
    expect(await agent.steerPrompt!(prompt, 'now')).toBe(false);
    outcome = 'failed';
    await expect(agent.steerPrompt!(prompt, 'now')).rejects.toThrow();
    expect(requests.map((item) => item.method)).not.toContain('session/cancel');
  } finally {
    stdin.end();
    stdout.end();
  }
});

it('bounds an unconfirmed delivery without cancelling or automatically resending it', async () => {
  vi.useFakeTimers();
  const receipt = deferred<Record<string, unknown>>();
  const connection = { extMethod: vi.fn().mockReturnValue(receipt.promise) };
  const agent = {} as AcpAgentApi;
  enableCodexSteering(agent, connection);
  try {
    const pending = agent.steerPrompt!(
      { sessionId: 'main', prompt: [{ type: 'text', text: 'hello' }] },
      'next'
    );
    const failure = expect(pending).rejects.toThrow('Codex message delivery timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    receipt.resolve({ outcome: 'injected' });
    await Promise.resolve();
    expect(connection.extMethod).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
