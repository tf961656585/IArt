// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { loadHubHtml } from './hubTestUtils';
import { MemoryResponse, parseJsonObject, type MockRequest, type RouterModule } from './helpers/http-test-types';
import { sharedRequire, cjsRequireAs, cjsImportAs } from './helpers/cjs-mock';
import { HUB_LOCAL_WRITE_TOKEN_ENV } from '@iart/contracts';

const HUB_WRITE_TOKEN = 'a'.repeat(32);

const idleUpdateState = {
  status: 'idle' as const,
  appVersion: 'dev',
  channel: 'stable' as const,
  platform: 'darwin' as const,
  arch: 'arm64' as const,
  lastCheckedAt: null,
  logPath: null,
};

const createElectronStub = (hubWriteToken: string = HUB_WRITE_TOKEN) => ({
  getHubBootstrap: async () => ({
    runtime: 'desktop-hub' as const,
    backendBaseUrl: 'http://127.0.0.1:39000',
    hubWriteToken,
  }),
  getAppVersion: async () => 'dev',
  getUpdateState: async () => idleUpdateState,
  getUpdaterLogInfo: async () => ({ success: true, exists: false, path: '' }),
  getCurrentProjectPath: async () => null,
  setCurrentProjectPath: async () => undefined,
  selectFolder: async () => ({
    status: 'canceled' as const,
    path: null,
    errorCode: null,
    userMessage: null,
    debugMessage: null,
  }),
  selectProjectFolder: async () => ({
    status: 'canceled' as const,
    path: null,
    errorCode: null,
    userMessage: null,
    debugMessage: null,
  }),
  openExternal: async () => true,
  openEditorWindow: async () => true,
  revealProjectFolder: async () => ({ ok: true, path: '/tmp/project' }),
  revealGlobalJobsFolder: async () => ({ ok: true }),
  revealUpdaterLog: async () => ({ success: true }),
  checkForUpdates: async () => ({ status: 'skipped' as const, reason: 'throttled', state: idleUpdateState }),
  startUpdateDownload: async () => ({ status: 'success' as const, state: idleUpdateState }),
  installUpdate: () => ({ status: 'success' as const, state: idleUpdateState }),
  closeWindow: async () => undefined,
  storage: {
    'storage:list-projects': async () => ({ projects: [] }),
  },
  onUpdateChecking: () => () => {},
  onUpdateAvailable: () => () => {},
  onUpdateNotAvailable: () => () => {},
  onUpdateDownloadProgress: () => () => {},
  onUpdateDownloaded: () => () => {},
  onUpdateError: () => () => {},
});

const createFetchStub = (options?: {
  initialConfig?: Record<string, unknown>;
  onSaveConfig?: (payload: Record<string, unknown>) => void;
}) => {
  const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const configState: Record<string, unknown> = {
    version: 1,
    preferredPort: 0,
    logLevel: 'info',
    maxUploadSize: 10 * 1024 * 1024 * 1024,
    maxMediaSize: 100 * 1024 * 1024,
    maxBatchTasks: 30,
    expandInlineParamsOnStartup: false,
    allowedRemoteHosts: ['gateway.example.com'],
    ...(options?.initialConfig ?? {}),
  };

  const buildConfigResponse = () => ({
    config: configState,
    resolved: {
      preferredPort: Number(configState['preferredPort'] ?? 0),
      logLevel: String(configState['logLevel'] ?? 'info'),
      maxUploadSize: Number(configState['maxUploadSize'] ?? 0),
      maxMediaSize: Number(configState['maxMediaSize'] ?? 0),
      maxBatchTasks: Number(configState['maxBatchTasks'] ?? 30),
      expandInlineParamsOnStartup: configState['expandInlineParamsOnStartup'] === true,
      allowedRemoteHosts: Array.isArray(configState['allowedRemoteHosts'])
        ? configState['allowedRemoteHosts']
        : [],
    },
    server: {
      port: 39000,
      baseUrl: 'http://127.0.0.1:39000',
    },
  });

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String((input as Request).url ?? input);
    if (raw.includes('/api/projects')) {
      return jsonResponse({ projects: [], openedProjectPaths: [] });
    }
    if (raw.includes('/api/config')) {
      if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
        const nextPayload = init?.body ? parseJsonObject(String(init.body)) : {};
        Object.assign(configState, nextPayload);
        options?.onSaveConfig?.(nextPayload);
      }
      return jsonResponse(buildConfigResponse());
    }
    if (raw.includes('/api/api-key-group-state')) {
      return jsonResponse({
        success: true,
        groups: [],
        policies: [],
        models: [],
        defaultPolicy: null,
      });
    }
    if (raw.includes('/api/account/balance')) {
      return jsonResponse({ balance: null });
    }
    return jsonResponse({});
  };
};

const normalizeHeaders = (headers?: HeadersInit) => {
  if (!headers) return {} as Record<string, string>;
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, String(value)]));
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])
  );
};

const toRequestBuffer = async (body?: BodyInit | null) => {
  if (body == null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf-8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf-8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  return Buffer.from(String(body), 'utf-8');
};

const createRouterBackedFetch = (
  handler: (req: unknown, res: unknown) => Promise<void>
) => {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const resolvedUrl =
      typeof input === 'string'
        ? new URL(input, 'http://localhost')
        : input instanceof URL
          ? new URL(String(input))
          : new URL(String((input as Request).url ?? input), 'http://localhost');
    const bodyBuffer = await toRequestBuffer(init?.body);
    const req = Readable.from(bodyBuffer ? [bodyBuffer] : []) as MockRequest;
    req.method = (init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET') ?? 'GET')
      .toUpperCase();
    req.url = `${resolvedUrl.pathname}${resolvedUrl.search}`;
    req.headers = {
      ...normalizeHeaders(typeof input !== 'string' && !(input instanceof URL) ? input.headers : undefined),
      ...normalizeHeaders(init?.headers),
    };
    Object.assign(req, {
      socket: {
        remoteAddress: '127.0.0.1',
      },
    });
    if (bodyBuffer && !req.headers['content-length']) {
      req.headers['content-length'] = String(bodyBuffer.length);
    }

    const res = new MemoryResponse();
    await handler(req, res);
    await new Promise((resolve) => res.once('finish', resolve));

    return new Response(res.body, {
      status: res.statusCode,
      headers: res.headers,
    });
  };
};

const waitFor = async (check: () => boolean, timeoutMs = 3000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Hub bootstrap to finish');
};

const findStyleRule = (rules: CSSRuleList | CSSRule[], selectorText: string) =>
  Array.from(rules).find(
    (rule): rule is CSSStyleRule =>
      'selectorText' in rule && (rule as CSSStyleRule).selectorText === selectorText
  );

const findLightThemeRule = (rules: CSSRuleList | CSSRule[]) =>
  Array.from(rules).find(
    (rule): rule is CSSMediaRule =>
      'conditionText' in rule &&
      typeof rule.conditionText === 'string' &&
      rule.conditionText.includes('prefers-color-scheme: light')
  );

const getHubStaticPageUrl = () =>
  pathToFileURL(path.join(process.cwd(), 'apps', 'hub', 'dist-static', 'index.html')).toString();

type StorageHintsModule = {
  resolveBackendConfigFilePath: (options?: Record<string, unknown>) => string;
};

// TODO(hub-react-migration): 这些测试保护的是旧 vanilla Hub 的 DOM 启动行为。
// Hub renderer 正在迁移到 React（见 docs/hub/hub-renderer-architecture.md），
// 骨架阶段 DOM 结构与旧版不兼容。待对应 feature 域（projects/settings）迁移完成后，
// 逐个恢复并重写为基于 React 组件的测试。
describe.skip('Hub 首屏启动链路', () => {
  it('首页启动时应完成项目列表初始化，不再被未定义函数中断', async () => {
    const html = loadHubHtml();
    const startupErrors: string[] = [];
    const virtualConsole = new VirtualConsole();

    virtualConsole.on('jsdomError', (error) => {
      startupErrors.push(String(error?.stack || error?.message || error));
    });

    const dom = new JSDOM(html, {
      url: getHubStaticPageUrl(),
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.fetch = createFetchStub() as typeof window.fetch;
        (window as typeof window & { electron: unknown }).electron = createElectronStub();
        window.confirm = () => true;
        window.alert = () => {};
        window.open = () => null;
      },
    });

    await waitFor(() => {
      const text = dom.window.document.getElementById('projectStatus')?.textContent ?? '';
      return text.includes('已加载 0 个项目');
    });

    expect(startupErrors).toEqual([]);
    expect(dom.window.document.getElementById('projectStatus')?.textContent).toContain(
      '已加载 0 个项目'
    );

    const settingsTab = dom.window.document.querySelector('[data-tab="settings"]') as
      | HTMLButtonElement
      | null;
    settingsTab?.click();

    await waitFor(() => {
      const active = dom.window.document.getElementById('tab-settings')?.classList.contains('active');
      const authText = dom.window.document.getElementById('authStatus')?.textContent ?? '';
      return Boolean(active) && authText.includes('未登录');
    });

    expect(dom.window.document.getElementById('tab-settings')?.classList.contains('active')).toBe(true);
  });

  it('首屏开关在浅色主题下应同时锁住清晰的关闭态和开启态样式', () => {
    const html = loadHubHtml();
    const dom = new JSDOM(html);
    const styleSheet = dom.window.document.styleSheets[0];

    expect(styleSheet).toBeDefined();
    if (!styleSheet) {
      throw new Error('Hub static stylesheet was not loaded');
    }

    const lightThemeRule = findLightThemeRule(styleSheet.cssRules);
    const lightRootRule = lightThemeRule
      ? findStyleRule(lightThemeRule.cssRules, ':root')
      : null;
    const offSwitchRule = findStyleRule(styleSheet.cssRules, '.startup-inline-toggle-switch');
    const offStateRule = findStyleRule(styleSheet.cssRules, '.startup-inline-toggle-state');
    const onSwitchRule = findStyleRule(
      styleSheet.cssRules,
      '.startup-inline-toggle-input:checked + .startup-inline-toggle-switch'
    );
    const onStateRule = findStyleRule(
      styleSheet.cssRules,
      '.startup-inline-toggle[data-state="on"] .startup-inline-toggle-state'
    );

    expect(lightThemeRule).not.toBeNull();
    expect(lightRootRule?.style.getPropertyValue('--switch-off-bg').trim()).toBe('#e5e7eb');
    expect(lightRootRule?.style.getPropertyValue('--switch-off-border').trim()).toBe('#98a2b3');
    expect(lightRootRule?.style.getPropertyValue('--switch-off-pill-bg').trim()).toBe('#f3f4f6');
    expect(lightRootRule?.style.getPropertyValue('--switch-off-pill-text').trim()).toBe('#344054');
    expect(lightRootRule?.style.getPropertyValue('--switch-on-pill-bg').trim()).toBe('#dbeafe');
    expect(lightRootRule?.style.getPropertyValue('--switch-on-pill-text').trim()).toBe('#1d4ed8');

    expect(offSwitchRule?.style.getPropertyValue('width').trim()).toBe('56px');
    expect(offSwitchRule?.style.getPropertyValue('height').trim()).toBe('32px');
    expect(offSwitchRule?.style.getPropertyValue('background').trim()).toBe('var(--switch-off-bg)');
    expect(offSwitchRule?.style.getPropertyValue('border').trim()).toBe(
      '1px solid var(--switch-off-border)'
    );

    expect(offStateRule?.style.getPropertyValue('background').trim()).toBe(
      'var(--switch-off-pill-bg)'
    );
    expect(offStateRule?.style.getPropertyValue('color').trim()).toBe(
      'var(--switch-off-pill-text)'
    );
    expect(offStateRule?.style.getPropertyValue('border').trim()).toBe(
      '1px solid var(--switch-off-pill-border)'
    );

    expect(onSwitchRule?.style.getPropertyValue('background').trim()).toBe('var(--switch-on-bg)');
    expect(onSwitchRule?.style.getPropertyValue('border-color').trim()).toBe(
      'var(--switch-on-border)'
    );
    expect(onStateRule?.style.getPropertyValue('background').trim()).toBe(
      'var(--switch-on-pill-bg)'
    );
    expect(onStateRule?.style.getPropertyValue('color').trim()).toBe(
      'var(--switch-on-pill-text)'
    );
  });

  it('设置页应直接提供首屏开关，并能保存后重新回显', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-hub-startup-bootstrap-'));
    const previousHubWriteTokenEnv = process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
    try {
      (globalThis as Record<string, unknown>)['__IARTS_DATA_ROOT'] = path.join(tempRoot, 'storage');
      process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = HUB_WRITE_TOKEN;
      vi.resetModules();

      const router = await cjsImportAs<RouterModule>('../../apps/backend/dist/local-server/router.cjs');
      const storageHints = cjsRequireAs<StorageHintsModule>(sharedRequire('@iart/utils/storage-root-hints'));
      const handler = router.createRequestHandler({ baseDir: process.cwd() });
      const routerFetch = createRouterBackedFetch(handler);
      const html = loadHubHtml();

      const dom = new JSDOM(html, {
        url: getHubStaticPageUrl(),
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        beforeParse(window) {
          window.fetch = routerFetch as typeof window.fetch;
          (window as typeof window & { electron: unknown }).electron = createElectronStub();
          window.confirm = () => true;
          window.alert = () => {};
          window.open = () => null;
          // file:// opaque origin 下 jsdom 的 localStorage/sessionStorage 访问会抛
          // SecurityError。断言失败时 chai 序列化含 DOM 对象的实际值会触发它，把真实
          // AssertionError 掩盖成一句「localStorage is not available」。注入桩消除该放大器。
          const fakeStorage = {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
            clear: () => {},
            key: () => null,
            length: 0,
          };
          Object.defineProperty(window, 'localStorage', { value: fakeStorage, configurable: true });
          Object.defineProperty(window, 'sessionStorage', { value: fakeStorage, configurable: true });
        },
      });

      const settingsTab = dom.window.document.querySelector('[data-tab="settings"]') as
        | HTMLButtonElement
        | null;

      await waitFor(() => {
        const text = dom.window.document.getElementById('projectStatus')?.textContent ?? '';
        return text.includes('已加载 0 个项目');
      });

      settingsTab?.click();

      await waitFor(() => {
        const sections = Array.from(
          dom.window.document.querySelectorAll<HTMLDetailsElement>('.settings-section-card')
        );
        const statusText = dom.window.document.getElementById('settingsStatus')?.textContent ?? '';
        return sections.length >= 2 && statusText.includes('配置已加载');
      });

      const startupCard = dom.window.document.getElementById('startupInlineParamsSettingsCard');
      const startupExpandToggle = dom.window.document.getElementById(
        'expandInlineParamsOnStartup'
      ) as HTMLInputElement | null;
      const startupToggleControl = dom.window.document.getElementById(
        'expandInlineParamsOnStartupControl'
      ) as HTMLLabelElement | null;
      const startupToggleSwitch = startupCard?.querySelector('.startup-inline-toggle-switch');
      const startupToggleState = dom.window.document.getElementById('expandInlineParamsOnStartupState');
      const saveSettingsBtn = dom.window.document.getElementById('saveSettings') as HTMLButtonElement | null;
      const reloadSettingsBtn = dom.window.document.getElementById('reloadSettings') as HTMLButtonElement | null;
      const settingsStatus = dom.window.document.getElementById('settingsStatus');

      expect(startupCard?.textContent).toContain('启动时展开节点参数区域');
      expect(startupExpandToggle?.getAttribute('role')).toBe('switch');
      expect(startupExpandToggle?.checked).toBe(false);
      expect(startupExpandToggle?.closest('.settings-section-card')).toBeNull();
      expect(startupToggleControl?.dataset['state']).toBe('off');
      expect(startupToggleSwitch).not.toBeNull();
      expect(startupToggleState?.textContent).toContain('当前关闭');
      expect(saveSettingsBtn).not.toBeNull();
      expect(reloadSettingsBtn).not.toBeNull();

      // 设置页 card 结构与「运行策略」展开交互已迁出至独立用例
      // 「设置页应包含关键设置卡片且可折叠」——此处只验证首屏开关端到端链路。

      startupToggleControl?.click();

      await waitFor(() => startupExpandToggle?.checked === true);
      expect(startupToggleControl?.dataset['state']).toBe('on');
      expect(startupToggleState?.textContent).toContain('当前开启');

      saveSettingsBtn?.click();

      await waitFor(() => (settingsStatus?.textContent ?? '').includes('配置已保存'));

      const persistedConfigResponse = await routerFetch('http://localhost/api/config');
      const persistedConfig = (await persistedConfigResponse.json()) as {
        config?: { expandInlineParamsOnStartup?: boolean };
      };
      expect(persistedConfig.config?.expandInlineParamsOnStartup).toBe(true);

      const configFilePath = storageHints.resolveBackendConfigFilePath();
      expect(fs.existsSync(configFilePath)).toBe(true);
      const savedConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf-8')) as {
        expandInlineParamsOnStartup?: boolean;
      };
      expect(savedConfig.expandInlineParamsOnStartup).toBe(true);

      if (startupExpandToggle) {
        startupExpandToggle.checked = false;
        startupExpandToggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      }
      expect(startupToggleControl?.dataset['state']).toBe('off');
      expect(startupToggleState?.textContent).toContain('当前关闭');
      reloadSettingsBtn?.click();

      await waitFor(() => startupExpandToggle?.checked === true);
      expect(startupToggleControl?.dataset['state']).toBe('on');
      expect(startupToggleState?.textContent).toContain('当前开启');
    } finally {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
      if (previousHubWriteTokenEnv === undefined) {
        delete process.env[HUB_LOCAL_WRITE_TOKEN_ENV];
      } else {
        process.env[HUB_LOCAL_WRITE_TOKEN_ENV] = previousHubWriteTokenEnv;
      }
      delete (globalThis as Record<string, unknown>)['__IARTS_DATA_ROOT'];
      vi.resetModules();
    }
  });

  it('设置页应包含关键设置卡片且可折叠', async () => {
    const html = loadHubHtml();
    const dom = new JSDOM(html, {
      url: getHubStaticPageUrl(),
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.fetch = createFetchStub() as typeof window.fetch;
        (window as typeof window & { electron: unknown }).electron = createElectronStub();
        window.confirm = () => true;
        window.alert = () => {};
        window.open = () => null;
      },
    });

    const settingsTab = dom.window.document.querySelector('[data-tab="settings"]') as
      | HTMLButtonElement
      | null;

    await waitFor(() => {
      const text = dom.window.document.getElementById('projectStatus')?.textContent ?? '';
      return text.includes('已加载 0 个项目');
    });

    settingsTab?.click();

    await waitFor(() => {
      const sections = Array.from(
        dom.window.document.querySelectorAll<HTMLDetailsElement>('.settings-section-card')
      );
      return sections.length >= 2;
    });

    const sections = Array.from(
      dom.window.document.querySelectorAll<HTMLElement>('.settings-section-card')
    );
    // 包含语义：只保证关键 card 存在，不焊死总数与顺序，新增设置 card 不再炸此用例。
    const titles = sections.map((section) => section.querySelector('h2')?.textContent?.trim() ?? '');
    expect(titles).toEqual(
      expect.arrayContaining([
        '服务商',
        '运行策略',
        '网络代理',
      ])
    );
    // 每个 section 都是可折叠 details，有 summary + body 结构。
    sections.forEach((section) => {
      expect(section).toBeInstanceOf(dom.window.HTMLDetailsElement);
      expect((section as HTMLDetailsElement).open).toBe(false);
      expect(section.querySelector('summary')).not.toBeNull();
      expect(section.querySelector('.settings-section-body')).not.toBeNull();
    });
  });
});
