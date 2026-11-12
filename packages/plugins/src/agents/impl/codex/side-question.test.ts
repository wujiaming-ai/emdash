import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { connectCodexAcp } from './side-question';

it.each([undefined, 1])(
  'only enables the extension when the adapter advertises it (%s)',
  async (capability) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const methods: string[] = [];
    stdin.on('data', (data: Buffer) => {
      const request = JSON.parse(data.toString());
      if (!('id' in request)) return;
      methods.push(request.method);
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: 1,
              agentCapabilities: {},
              authMethods: [],
              _meta: {
                'emdash.dev/side-question': capability,
                'emdash.dev/activities': capability,
              },
            }
          : { text: 'side answer' };
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    });
    const agent = connectCodexAcp({ stdin, stdout }, () => ({
      sessionUpdate: vi.fn(),
      requestPermission: vi.fn(),
    }));
    try {
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
      expect(agent.supportsActivities).toBe(capability === 1);
      if (capability === 1) {
        expect(
          await agent.sideQuestion?.({
            sessionId: 'source',
            sideId: crypto.randomUUID(),
            action: 'ask',
            question: 'Why?',
          })
        ).toEqual({ text: 'side answer' });
        expect(methods).toEqual(['initialize', '_emdash/sideQuestion']);
      } else expect(agent.sideQuestion).toBeUndefined();
    } finally {
      stdin.end();
      stdout.end();
    }
  }
);

it.each([undefined, 1])(
  'negotiates a normal ephemeral session separately from legacy side requests (%s)',
  async (capability) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const requests: Array<{ method: string; params: unknown }> = [];
    stdin.on('data', (data: Buffer) => {
      const request = JSON.parse(data.toString());
      if (!('id' in request)) return;
      requests.push(request);
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: 1,
              agentCapabilities: {},
              authMethods: [],
              _meta: { 'emdash.dev/side-session': capability },
            }
          : { sessionId: 'side-native', configOptions: [] };
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    });
    const agent = connectCodexAcp({ stdin, stdout }, () => ({
      sessionUpdate: vi.fn(),
      requestPermission: vi.fn(),
    }));
    try {
      await agent.initialize({ protocolVersion: 1 });
      if (capability === 1) {
        expect(
          await agent.forkSideSession?.({ sessionId: 'main', cwd: '/repo', mcpServers: [] })
        ).toEqual({ sessionId: 'side-native', configOptions: [] });
        expect(requests.at(-1)).toMatchObject({
          method: 'session/fork',
          params: { sessionId: 'main', _meta: { 'emdash.dev/side-session': 1 } },
        });
      } else expect(agent.forkSideSession).toBeUndefined();
      expect(agent.sideQuestion).toBeUndefined();
    } finally {
      stdin.end();
      stdout.end();
    }
  }
);
