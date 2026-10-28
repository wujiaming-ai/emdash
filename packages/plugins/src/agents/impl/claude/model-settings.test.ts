import { buildEffortConfigOption } from '@agentclientprotocol/claude-agent-acp/dist/session-effort.js';
import { getAvailableModels } from '@agentclientprotocol/claude-agent-acp/dist/session-model.js';
import type { ModelInfo, Query, Settings } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const alias = 'gateway/custom-model[1m]';
const backendModel = 'deployment-build-20261017';
const models: ModelInfo[] = [
  { value: 'default', displayName: 'Default', description: 'Default model' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet' },
  {
    value: alias,
    displayName: 'Opus (1M context)',
    description: 'A provider-supplied label that does not describe the custom model',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
];

function fixture(settings: Settings, resumed = false, supportedModels = models) {
  const setModel = vi.fn<Query['setModel']>().mockResolvedValue(undefined);
  const logger = { log: vi.fn(), error: vi.fn() };
  return {
    setModel,
    logger,
    resolve: () =>
      getAvailableModels(
        { setModel } as unknown as Query,
        supportedModels,
        supportedModels,
        { getSettings: () => settings },
        logger,
        resumed,
        'fixture-session',
        resumed ? backendModel : undefined
      ),
  };
}

describe('Claude model settings compatibility patch', () => {
  beforeEach(() => vi.stubEnv('ANTHROPIC_MODEL', undefined));
  afterEach(() => vi.unstubAllEnvs());

  it.each([false, true])(
    'keeps the configured alias and its capabilities on resume=%s',
    async (resumed) => {
      const test = fixture({ env: { ANTHROPIC_MODEL: alias } }, resumed);
      const state = await test.resolve();
      expect(state.currentModelId).toBe(alias);
      expect(state.availableModels.find((model) => model.modelId === alias)).toEqual({
        modelId: alias,
        name: alias,
        description: undefined,
      });
      expect(state.availableModels.map((model) => model.modelId)).toEqual(
        models.map((model) => model.value)
      );
      expect(test.setModel.mock.calls).toEqual(resumed ? [[alias]] : []);
      expect(buildEffortConfigOption(models, state.currentModelId, 'high', false)).toMatchObject({
        category: 'thought_level',
        currentValue: 'high',
        options: expect.arrayContaining([{ value: 'high', name: 'High' }]),
      });
    }
  );

  it('keeps process environment priority over file-backed model preferences', async () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'sonnet');
    const test = fixture({ env: { ANTHROPIC_MODEL: alias }, model: alias }, true);
    expect((await test.resolve()).currentModelId).toBe('sonnet');
    expect(test.setModel).toHaveBeenCalledWith('sonnet');
  });

  it('prefers file-backed environment over the top-level model setting', async () => {
    expect(
      (await fixture({ env: { ANTHROPIC_MODEL: alias }, model: 'sonnet' }).resolve()).currentModelId
    ).toBe(alias);
  });

  it('keeps a resumed backend identity when no model override exists', async () => {
    const test = fixture({}, true);
    expect((await test.resolve()).currentModelId).toBe(backendModel);
    expect(test.setModel).not.toHaveBeenCalled();
  });

  it('does not report an override that the CLI refused to apply on resume', async () => {
    const test = fixture({ env: { ANTHROPIC_MODEL: alias } }, true);
    test.setModel.mockRejectedValue(new Error('fixture rejection'));
    expect((await test.resolve()).currentModelId).toBe(backendModel);
    expect(test.logger.error).toHaveBeenCalled();
  });

  it('does not invent effort capabilities for an unsupported custom model', async () => {
    const unsupported = models.map((model) => ({ ...model, supportsEffort: false }));
    const state = await fixture({ env: { ANTHROPIC_MODEL: alias } }, true, unsupported).resolve();
    expect(state.currentModelId).toBe(alias);
    expect(
      buildEffortConfigOption(unsupported, state.currentModelId, 'high', false)
    ).toBeUndefined();
  });
});
