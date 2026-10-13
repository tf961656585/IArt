import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelAssetNodeProjection } from '@iart/contracts/model-asset-contract';
import type * as ApiConfigNS from '@/client/utils/apiConfig';
import type { ElectronBridge } from '@/client/utils/electronBridge';

const bootstrapFixture = {
  runtime: 'desktop' as const,
  backendBaseUrl: 'http://127.0.0.1:39000',
  projectPath: '/tmp/demo.iartproj',
  projectRef: 'prj_0123456789abcdef0123456789abcdef',
  sessionToken: 'desktop:test-session',
  locale: 'zh-CN' as const,
  windowContext: {
    entry: 'editor' as const,
  },
};

let currentDesktopBootstrap: typeof bootstrapFixture | null = bootstrapFixture;

const setWindowElectron = (
  bridge: Partial<ElectronBridge> | undefined,
): void => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: bridge,
  });
};

const createRuntimeProjection = (
  overrides: Partial<ModelAssetNodeProjection> = {},
): ModelAssetNodeProjection => ({
  package_id: 'zimage',
  model_id: 'z-image-turbo',
  node_type: 'model',
  description: 'runtime projection test fixture',
  group_key: 'alibaba',
  icon_ref: 'provider-alibaba-icon',
  capability: {
    input_modalities: ['text'],
    output_modalities: ['image'],
    supports_async_task: false,
    constraints: [],
  },
  ports: {
    inputs: [
      {
        id: 'prompt',
        name: '提示词',
        data_type: 'text',
        field_key: 'prompt',
        required: true,
      },
    ],
    outputs: [
      {
        id: 'image',
        name: '图像',
        data_type: 'image',
        field_key: 'output_image',
        multiple: true,
      },
    ],
  },
  parameter_schema: {
    schema_type: 'object',
    fields: [
      {
        field_key: 'prompt',
        label: '提示词',
        component: 'textarea',
        data_source: 'form',
        required: true,
        default_value: '',
      },
    ],
    required_fields: ['prompt'],
    default_values: {
      prompt: '',
    },
    validation_rules: [],
  },
  execution_profile: {
    task_type: 'image',
    supports_async_task: false,
  },
  visibility: {
    visible: true,
    order: 1,
  },
  runtime: {
    provider_id: 'alibaba',
    default_task_type: 'image',
    mode: 'image',
    execution_driver: 'http_formal_task',
    payload_format: 'json',
    payload_format_rule: undefined,
    aliases: undefined,
    route_segment: undefined,
    workspace: undefined,
    api_defaults: {
      endpoint: '/v1/images/generations',
      method: 'POST',
      contentType: 'application/json',
      headers: undefined,
    },
    payload_rules: {
      'body.model': {
        kind: 'literal',
        value: 'z-image-turbo',
      },
      'body.prompt': {
        kind: 'field',
        field_key: 'prompt',
        transforms: undefined,
        fallback: undefined,
        media_target: undefined,
        multipart_array_naming: undefined,
      },
    },
    url_input_upload_mode: undefined,
    url_input_upload_target_type: undefined,
    capabilities: undefined,
    pre_requests: undefined,
  },
  ...overrides,
});

const renderHookHarness = async (options?: {
  bootstrap?: typeof bootstrapFixture | null;
  projectionPayload?: unknown;
  runtimeConfigs?: unknown[];
  useRealProjectionBridge?: boolean;
  fetchModelAssetNodeProjectionsImpl?: (() => Promise<unknown>) | undefined;
}) => {
  vi.resetModules();
  currentDesktopBootstrap = options && 'bootstrap' in options ? options.bootstrap ?? null : bootstrapFixture;

  const mocks = {
    initAutoDiscovery: vi.fn(async () => undefined),
    setRuntimeProjectedModels: vi.fn(),
    fetchModelAssetNodeProjections:
      options && typeof options.fetchModelAssetNodeProjectionsImpl === 'function'
        ? vi.fn(options.fetchModelAssetNodeProjectionsImpl)
        : vi.fn(async () => (options ? options.projectionPayload ?? null : null)),
    buildModelConfigsFromNodeProjections: vi.fn(() => options?.runtimeConfigs ?? []),
    initModelStore: vi.fn(async () => undefined),
    registerModelAssetLocalizationBundles: vi.fn(),
    setClientLanguage: vi.fn(async () => undefined),
    setRuntimeFlags: vi.fn(),
    fetchRuntimeFlagsFromElectron: vi.fn(async () => ({ isPackaged: true })),
    fetchEditorBootstrapFromElectron: vi.fn(async () => currentDesktopBootstrap),
    isElectronEnvironment: vi.fn(() => true),
    hasLocalHubBaseHint: vi.fn(() => false),
    reportDesktopE2EEvent: vi.fn(async () => true),
  };

  vi.doMock('@/client/config/models.config', () => ({
    initAutoDiscovery: mocks.initAutoDiscovery,
    setRuntimeProjectedModels: mocks.setRuntimeProjectedModels,
  }));
  vi.doMock('@/client/api/modelAssetProjections', () => ({
    fetchModelAssetNodeProjections: mocks.fetchModelAssetNodeProjections,
  }));
  if (!options?.useRealProjectionBridge) {
    vi.doMock('@/client/config/modelAssetProjectionBridge', () => ({
      buildModelConfigsFromNodeProjections: mocks.buildModelConfigsFromNodeProjections,
    }));
  } else {
    vi.doUnmock('@/client/config/modelAssetProjectionBridge');
  }
  vi.doMock('@/client/store/modelStore', () => ({
    useModelStore: {
      getState: () => ({ models: [] }),
    },
    initModelStore: mocks.initModelStore,
  }));
  vi.doMock('@/client/utils/electronBridge', () => ({
    fetchEditorBootstrapFromElectron: mocks.fetchEditorBootstrapFromElectron,
    fetchRuntimeFlagsFromElectron: mocks.fetchRuntimeFlagsFromElectron,
    isElectronEnvironment: mocks.isElectronEnvironment,
  }));
  vi.doMock('@/client/utils/apiConfig', async () => {
    const actual = await vi.importActual<typeof ApiConfigNS>(
      '@/client/utils/apiConfig',
    );
    return {
      ...actual,
      hasLocalHubBaseHint: mocks.hasLocalHubBaseHint,
    };
  });
  vi.doMock('@/client/utils/runtimeFlags', () => ({
    setRuntimeFlags: mocks.setRuntimeFlags,
  }));
  vi.doMock('@/client/utils/desktopE2E', () => ({
    reportDesktopE2EEvent: mocks.reportDesktopE2EEvent,
  }));
  vi.doMock('@/lib/i18n/client', () => ({
    registerModelAssetLocalizationBundles: mocks.registerModelAssetLocalizationBundles,
    setClientLanguage: mocks.setClientLanguage,
  }));

  const [{ default: useBootstrapClient, resetBootstrapClientForTests }, { useRuntimeStore }] = await Promise.all([
    import('../useBootstrapClient'),
    import('@/client/store/runtimeStore'),
  ]);

  resetBootstrapClientForTests();

  useRuntimeStore.setState({
    bootstrapStatus: 'idle',
    bootstrapError: null,
    desktopBootstrap: null,
    backendBaseUrl: null,
    projectPath: null,
    locale: 'zh-CN',
    appVersion: 'dev',
  });

  const Harness = () => {
    useBootstrapClient();
    return null;
  };

  render(<Harness />);

  return {
    useRuntimeStore,
    mocks,
  };
};

describe('useBootstrapClient desktop runtime', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Reflect.deleteProperty(window, 'electron');
    setWindowElectron({});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.resetModules();
    vi.clearAllMocks();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    Reflect.deleteProperty(window, 'electron');
  });

  it('将 Desktop Shell bootstrap 落入 runtime store，作为 renderer 真源', async () => {
    const { useRuntimeStore, mocks } = await renderHookHarness({
      bootstrap: bootstrapFixture,
    });

    await waitFor(() => {
      expect(useRuntimeStore.getState().bootstrapStatus).toBe('ready');
    });

    expect(useRuntimeStore.getState().desktopBootstrap).toEqual(bootstrapFixture);
    expect(useRuntimeStore.getState().backendBaseUrl).toBe('http://127.0.0.1:39000');
    expect(useRuntimeStore.getState().projectPath).toBe('/tmp/demo.iartproj');
    expect(useRuntimeStore.getState().desktopBootstrap?.sessionToken).toBe('desktop:test-session');
    expect(mocks.setClientLanguage).toHaveBeenCalledWith('zh-CN');
    expect(mocks.fetchEditorBootstrapFromElectron).toHaveBeenCalledTimes(1);
    expect(mocks.fetchModelAssetNodeProjections).toHaveBeenCalledTimes(1);
    expect(mocks.reportDesktopE2EEvent).toHaveBeenCalledWith('renderer-bootstrap-ready', {
      backendBaseUrl: 'http://127.0.0.1:39000',
      projectPath: '/tmp/demo.iartproj',
      sessionToken: 'desktop:test-session',
    });
    expect(mocks.setRuntimeProjectedModels).toHaveBeenCalledWith([]);
  });

  it('真实 e2e ready 观测点应在宿主 bootstrap 落库后立即上报，不等待后置模型链路', async () => {
    const pendingProjectionPromise = new Promise<unknown>(() => undefined);
    const { useRuntimeStore, mocks } = await renderHookHarness({
      bootstrap: bootstrapFixture,
      fetchModelAssetNodeProjectionsImpl: () => pendingProjectionPromise,
    });

    await waitFor(() => {
      expect(useRuntimeStore.getState().bootstrapStatus).toBe('ready');
    });

    await waitFor(() => {
      expect(mocks.reportDesktopE2EEvent).toHaveBeenCalledWith('renderer-bootstrap-ready', {
        backendBaseUrl: 'http://127.0.0.1:39000',
        projectPath: '/tmp/demo.iartproj',
        sessionToken: 'desktop:test-session',
      });
    });

    expect(mocks.fetchModelAssetNodeProjections).toHaveBeenCalledTimes(1);
    expect(mocks.initModelStore).not.toHaveBeenCalled();
  });

  it('缺失 bootstrap 时进入桌面错误态，而不是继续猜运行时上下文', async () => {
    const { useRuntimeStore, mocks } = await renderHookHarness({
      bootstrap: null,
    });

    await waitFor(() => {
      expect(useRuntimeStore.getState().bootstrapStatus).toBe('error');
    });

    expect(useRuntimeStore.getState().desktopBootstrap).toBeNull();
    expect(useRuntimeStore.getState().backendBaseUrl).toBeNull();
    expect(useRuntimeStore.getState().projectPath).toBeNull();
    expect(useRuntimeStore.getState().desktopBootstrap?.sessionToken ?? null).toBeNull();
    expect(useRuntimeStore.getState().bootstrapError).toBe('项目打开失败，请重新打开项目。');
    expect(mocks.setClientLanguage).not.toHaveBeenCalled();
  });

  it('投影存在 diagnostics 或映射丢弃时应输出可观测告警', async () => {
    const projectionPayload = {
      success: true,
      projections: [{ model_id: 'a' }, { model_id: 'b' }],
      localization_bundles: [],
      diagnostics: [{ package_id: 'pkg-a', code: 'bad_package', message: 'broken' }],
    };
    const runtimeConfigs = [{ modelId: 'a' }];

    const { useRuntimeStore } = await renderHookHarness({
      bootstrap: bootstrapFixture,
      projectionPayload,
      runtimeConfigs,
    });

    await waitFor(() => {
      expect(useRuntimeStore.getState().bootstrapStatus).toBe('ready');
    });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[model-asset] runtime projection mapping dropped entries',
      expect.objectContaining({ total: 2, mapped: 1, dropped: 1 }),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[model-asset] projection diagnostics',
      projectionPayload.diagnostics,
    );
  });

  it('投影数组含 null 坏对象时仍应完成 bootstrap 并注入其余运行时模型', async () => {
    const projectionPayload = {
      success: true,
      projections: [null, createRuntimeProjection()],
      localization_bundles: [],
      diagnostics: [],
    };

    const { useRuntimeStore, mocks } = await renderHookHarness({
      bootstrap: bootstrapFixture,
      projectionPayload,
      useRealProjectionBridge: true,
    });

    await waitFor(() => {
      expect(useRuntimeStore.getState().bootstrapStatus).toBe('ready');
    });

    expect(mocks.setRuntimeProjectedModels).toHaveBeenCalledWith([
      expect.objectContaining({ modelId: 'z-image-turbo' }),
    ]);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[model-asset] projection dropped',
      expect.objectContaining({
        reason: 'projection_invalid',
        error: 'projection must be a non-null object',
      }),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[model-asset] runtime projection mapping dropped entries',
      expect.objectContaining({ total: 2, mapped: 1, dropped: 1 }),
    );
  });
});
