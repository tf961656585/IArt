import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ProviderConnection } from '@iart/contracts';

import { ProviderSection } from '../ProviderSection';
import { createHubApiClient } from '../../../client/api/hub-api';
import { createHubHttpClient } from '../../../client/adapters/http-client';
import { countModelsByConnection } from '../provider-connection/invalidity';
import type { ProviderConnectionData } from '../provider-connection/useProviderConnectionData';

/**
 * 服务商列表卡片的密钥状态（2026-10-29）。
 *
 * 列表与详情共用 `credentialDisplay` 的状态词：同一个密钥状态在两处只有一套说法，
 * 不允许列表说「密钥异常」而详情说「需要重新填写」。
 *
 * 密钥不用胶囊徽章（`docs/ui-copy-standard.md` 第 9 条）：列表卡片上的胶囊仍只表达
 * 服务商状态（已启用 / 已停用 / 缺少密钥），密钥状态是行 2 的纯文本 / 异常点文字。
 */

const BASE = 'http://localhost:4877';
const WRITE_TOKEN = 'a'.repeat(32);

const connection: ProviderConnection = {
  connection_id: 'up_conn_list1',
  display_name: '我的网关',
  base_url: 'https://api.example.com',
  has_credential: true,
  lifecycle: 'enabled',
  revision: 1,
  created_at: '2026-10-29T00:00:00.000Z',
  updated_at: '2026-10-29T00:00:00.000Z',
};

/** 被 mock 的数据源：用例把当前连接刷进来，分区按它的形状渲染列表与详情。 */
const stateRef = vi.hoisted(() => ({ current: null as ProviderConnectionData | null }));

vi.mock('../provider-connection/ProviderDataContext', () => ({
  useProviderData: (): ProviderConnectionData => {
    if (stateRef.current === null) throw new Error('用例没有装载数据源');
    return stateRef.current;
  },
}));

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** 分区挂载时会读接口格式下拉选项：只挡掉这一条网络，其余请求视为用例写错。 */
const stubFetch = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
      const url = String(input);
      if (url.includes('/api/interface-formats')) return jsonResponse({ formats: [] });
      throw new Error(`未预期的请求：${url}`);
    }),
  );
};

const dataFor = (target: ProviderConnection): ProviderConnectionData => ({
  api: createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN)),
  connections: [target],
  activeRoutes: {},
  activeRecordIds: new Set(),
  connectionById: new Map([[target.connection_id, target]]),
  modelCountByConnection: countModelsByConnection([]),
  catalog: [],
  chatCatalog: [],
  catalogUnavailable: false,
  chatCatalogUnavailable: false,
  thinkingTierPool: { builtin: [], custom: [] },
  thinkingTierPoolUnavailable: false,
  customChatModels: [],
  customChatModelsUnavailable: false,
  customGenerationModels: [],
  customGenerationModelsUnavailable: false,
  interfaceRecipes: [],
  interfaceRecipesUnavailable: false,
  agentDefaultModelId: null,
  saveAgentDefaultModel: async () => undefined,
  generationDefaultModelId: null,
  saveGenerationDefaultModel: async () => undefined,
  loadState: 'ready',
  loadError: null,
  notice: null,
  setNotice: () => undefined,
  reload: async () => undefined,
});

/** 渲染分区：首条连接自动选中，列表卡片与详情同屏。 */
const renderSection = (overrides: Partial<ProviderConnection> = {}): void => {
  stubFetch();
  stateRef.current = dataFor({ ...connection, ...overrides });
  render(<ProviderSection />);
};

const rail = (): HTMLElement => screen.getByRole('group', { name: '服务商列表' });

/** 列表里那张服务商卡片（role=button，按名称定位）。 */
const card = (): HTMLElement => within(rail()).getByRole('button', { name: /我的网关/ });

describe('服务商列表卡片：密钥状态与服务商状态分域', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('密钥读不出来：卡片显示与详情一致的「密钥需要重新填写」，服务商胶囊仍是「已启用」', () => {
    renderSection({ credential_status: 'needs_reentry', credential_protection: 'os_safe_storage' });

    expect(within(card()).getByText('密钥需要重新填写')).toHaveClass('text-destructive');
    // 服务商状态词不受密钥状态影响，也不复用密钥的说法
    expect(within(card()).getByText('已启用')).toBeInTheDocument();
    // 详情同屏，主按钮指向唯一恢复动作
    expect(screen.getByRole('button', { name: '重新填写密钥' })).toBeInTheDocument();
    // 两处只有一套说法：同屏只出现这一种异常状态词
    expect(screen.getAllByText('密钥需要重新填写')).toHaveLength(2);
  });

  it('弱保护：卡片与详情都带「（弱保护）」后缀，说明气泡只在详情出现', () => {
    renderSection({ credential_status: 'ready', credential_protection: 'obfuscated' });

    expect(within(card()).getByText('密钥已保存（弱保护）')).toBeInTheDocument();
    expect(screen.getAllByText('密钥已保存（弱保护）')).toHaveLength(2);
    // 解释入口挂在详情头的密钥状态旁，列表卡片不重复挂
    expect(screen.getAllByRole('button', { name: '密钥说明' })).toHaveLength(1);
  });

  it('两个字段都是 undefined：卡片与改造前一致（只有服务商状态，不出现密钥状态词）', () => {
    renderSection();

    expect(within(card()).getByText('已启用')).toBeInTheDocument();
    expect(within(card()).queryByText(/密钥/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '密钥说明' })).not.toBeInTheDocument();
    // 详情仍是改造前的说法
    expect(screen.getByText('密钥已保存')).toBeInTheDocument();
  });

  it('两个字段都是 null：同样按「没有该信息」处理，卡片不显示异常态', () => {
    renderSection({ credential_status: null, credential_protection: null });

    expect(within(card()).queryByText(/密钥/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '密钥说明' })).not.toBeInTheDocument();
    expect(screen.getByText('密钥已保存')).toBeInTheDocument();
  });

  it('系统钥匙串保护且可读：卡片不出现密钥状态词，详情仍是「密钥已保存」', () => {
    renderSection({ credential_status: 'ready', credential_protection: 'os_safe_storage' });

    expect(within(card()).queryByText(/密钥/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '密钥说明' })).not.toBeInTheDocument();
    expect(screen.getByText('密钥已保存')).toBeInTheDocument();
  });
});
