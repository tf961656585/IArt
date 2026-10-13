import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfigEntry } from './models.config';

const createConfig = (overrides: Partial<ModelConfigEntry>): ModelConfigEntry => ({
  providerId: 'local',
  label: 'stub',
  modelId: 'stub-model',
  defaultTaskType: 'image',
  mode: 'image',
  adapter: { generate: async () => ({ ok: true }) },
  groupId: undefined,
  defaults: undefined,
  visible: undefined,
  role: undefined,
  description: undefined,
  aliases: undefined,
  routeSegment: undefined,
  workspace: undefined,
  canvasPortSpec: undefined,
  i18n: undefined,
  nodeGraphPorts: undefined,
  videoGenMode: undefined,
  canvasInspector: undefined,
  capabilities: undefined,
  assetCapabilities: undefined,
  assetInputContract: undefined,
  variantGroup: undefined,
  ...overrides,
});

describe('models.config runtime source selection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.doUnmock('./modelAutoDiscovery');
  });

  it('自动发现只暴露本地内建节点，远端模型必须走 runtime 注入', async () => {
    vi.doMock('./modelAutoDiscovery', () => ({
      discoverModels: vi.fn(async () => [
        createConfig({
          providerId: 'local',
          label: 'Edge Detect',
          modelId: 'edge-detect',
          role: 'processor',
        }),
        createConfig({
          providerId: 'google',
          label: 'Remote Gemini',
          modelId: 'gemini-3.1-flash-image',
        }),
      ]),
    }));

    const {
      initAutoDiscovery,
      findModelConfig,
      listModelConfigsWithSource,
      setRuntimeProjectedModels,
    } = await import('./models.config');

    await initAutoDiscovery();
    setRuntimeProjectedModels([]);

    expect(findModelConfig('edge-detect')?.providerId).toBe('local');
    expect(findModelConfig('gemini-3.1-flash-image')).toBeUndefined();
    expect(listModelConfigsWithSource().auto.map((item) => item.modelId)).toEqual(['edge-detect']);

    setRuntimeProjectedModels([
      createConfig({
        providerId: 'google',
        label: 'Remote Gemini',
        modelId: 'gemini-3.1-flash-image',
      }),
    ]);

    expect(findModelConfig('gemini-3.1-flash-image')?.providerId).toBe('google');
  });
});
