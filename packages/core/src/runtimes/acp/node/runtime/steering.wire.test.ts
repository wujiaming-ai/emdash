import { randomUUID } from 'node:crypto';
import { deferred } from '@emdash/shared/testing';
import { createTestWire } from '@emdash/wire/testing';
import { expect, it, vi } from 'vitest';
import { acpApiContract } from '../../api';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { createAcpController } from '../api/controller';
import { AcpRuntime } from './runtime';

it.each(['boundary', 'now', 'automatic'] as const)(
  'routes %s through the real session and Wire layers',
  async (mode) => {
    const h = makeAcpHarness();
    const gate = deferred<{ stopReason: 'end_turn' }>();
    h.agent.prompt.mockReturnValueOnce(gate.promise);
    const steerPrompt = vi.fn().mockResolvedValue(true);
    Object.assign(h.agent, {
      steerPrompt,
      ...(mode === 'automatic' ? { steerOnPrompt: true } : {}),
    });
    const runtime = new AcpRuntime(h.deps);
    const wire = createTestWire(acpApiContract, createAcpController(runtime));
    try {
      const conversationId = 'steering';
      const started = await wire.client.startSession({
        ...makeStartInput({ conversationId }),
        mode: 'fresh',
      });
      if (!started.success) throw new Error('Failed to start test session');
      await wire.client.sendPrompt({
        conversationId,
        promptId: randomUUID(),
        prompt: { text: 'first' },
      });
      const promptId = randomUUID();
      expect(
        await wire.client.sendPrompt({ conversationId, promptId, prompt: { text: 'follow up' } })
      ).toMatchObject({ success: true, data: { queued: true } });
      if (mode === 'now') {
        expect(
          await wire.client.sendQueuedPromptNow({ conversationId, id: promptId })
        ).toMatchObject({ success: true });
      } else if (mode === 'boundary') {
        await h.client().extMethod!('_emdash/drainQueuedPrompts', {
          sessionId: started.data.sessionId,
        });
      }
      await vi.waitFor(() => expect(steerPrompt).toHaveBeenCalledOnce());
      expect(steerPrompt).toHaveBeenCalledWith(
        { sessionId: started.data.sessionId, prompt: [{ type: 'text', text: 'follow up' }] },
        mode === 'now' ? 'now' : 'next'
      );
      expect(h.agent.cancel).not.toHaveBeenCalled();
      gate.resolve({ stopReason: 'end_turn' });
      await vi.waitFor(async () => {
        const history = await wire.client.loadHistory({ conversationId, limit: 100 });
        expect(history).toMatchObject({
          success: true,
          data: {
            kind: 'available',
            turns: [
              {
                items: [
                  expect.objectContaining({ text: 'first' }),
                  expect.objectContaining({ text: 'follow up', promptId }),
                ],
              },
            ],
          },
        });
      });
    } finally {
      gate.resolve({ stopReason: 'end_turn' });
      wire.dispose();
      await runtime.dispose();
    }
  }
);
