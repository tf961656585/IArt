import { describe, it, expect } from 'vitest';
import type { GenerationAdapter } from '@/client/adapters/types';
import { MODEL_CAPABILITY_KEYS, hasModelCapability, toModelConfigEntry, type ModelDefinition } from '../modelDefinition';

describe('model capabilities', () => {
  it('hasModelCapability should return true only for explicit capability flags', () => {
    const capability = MODEL_CAPABILITY_KEYS.executionMediaPromptOptimizer;
    expect(hasModelCapability(undefined, capability)).toBe(false);
    expect(hasModelCapability({}, capability)).toBe(false);
    expect(
      hasModelCapability(
        { capabilities: { [capability]: true } },
        capability,
      ),
    ).toBe(true);
    expect(
      hasModelCapability(
        { capabilities: { [capability]: false } },
        capability,
      ),
    ).toBe(false);
  });

  it('toModelConfigEntry should pass through capabilities (runtime)', () => {
    const adapterFixture: GenerationAdapter = {
      generate: async () => ({ ok: true }),
    };

    const def: ModelDefinition = {
      providerId: 'example',
      modelId: 'example-cap-test',
      groupId: undefined,
      label: 'Example',
      description: undefined,
      aliases: undefined,
      routeSegment: undefined,
      defaultTaskType: 'video',
      mode: 'video',
      visible: undefined,
      role: undefined,
      adapter: adapterFixture,
      defaults: undefined,
      workspace: undefined,
      canvasPortSpec: undefined,
      canvasPortSpecByVersion: undefined,
      i18n: undefined,
      nodeGraphPorts: undefined,
      videoGenMode: undefined,
      canvasInspector: undefined,
      capabilities: { [MODEL_CAPABILITY_KEYS.executionMediaPromptOptimizer]: true },
    };

    const cfg = toModelConfigEntry(def);
    const capabilities = cfg.capabilities;
    expect(capabilities !== undefined ? capabilities[MODEL_CAPABILITY_KEYS.executionMediaPromptOptimizer] : undefined).toBe(true);
  });
});
