import { randomUUID } from 'node:crypto';
import { deferred } from '@emdash/shared/testing';
import { createTestWire } from '@emdash/wire/testing';
import { expect, it, vi } from 'vitest';
import { acpApiContract } from '../../api';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { createAcpController } from '../api/controller';
import { AcpRuntime } from './runtime';

it('asks and cancels a side question without interrupting or appending to the main turn', async () => {
  const h = makeAcpHarness();
  const gate = deferred<{ stopReason: 'end_turn' }>();
  h.agent.prompt.mockReturnValueOnce(gate.promise);
  const sideQuestion = vi.fn().mockResolvedValue({ text: 'side answer' });
  Object.assign(h.agent, { sideQuestion });
  const runtime = new AcpRuntime(h.deps);
  const wire = createTestWire(acpApiContract, createAcpController(runtime));
  try {
    const conversationId = 'side-test';
    const started = await wire.client.startSession({
      ...makeStartInput({ conversationId }),
      mode: 'fresh',
    });
    if (!started.success) throw new Error('Session failed');
    await wire.client.sendPrompt({
      conversationId,
      promptId: randomUUID(),
      prompt: { text: 'main task' },
    });
    const sideId = randomUUID();
    expect(
      await wire.client.sideQuestion({
        conversationId,
        sideId,
        action: 'ask',
        question: 'explain',
        quote: 'selected text',
      })
    ).toMatchObject({ success: true, data: { text: 'side answer' } });
    await wire.client.sideQuestion({ conversationId, sideId, action: 'cancel' });
    expect(sideQuestion).toHaveBeenCalledWith({
      sessionId: started.data.sessionId,
      sideId,
      action: 'cancel',
    });
    expect(h.agent.cancel).not.toHaveBeenCalled();
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);
    gate.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(async () => {
      const history = await wire.client.loadHistory({ conversationId, limit: 100 });
      expect(JSON.stringify(history)).toContain('main task');
      expect(JSON.stringify(history)).not.toContain('side answer');
      expect(JSON.stringify(history)).not.toContain('explain');
    });
  } finally {
    gate.resolve({ stopReason: 'end_turn' });
    wire.dispose();
    await runtime.dispose();
  }
});
