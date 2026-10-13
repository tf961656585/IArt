import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

import type {
  CustomChatModel,
  ExecutableModelDirectoryEntry,
  ModelDeployment,
  ProviderConnection,
  ThinkingTierPool,
} from '@iart/contracts';
import { ProviderSection } from '../ProviderSection';
import { createHubApiClient } from '../../../client/api/hub-api';
import { createHubHttpClient } from '../../../client/adapters/http-client';
import { buildConfigUpdatePayload } from '../../../client/settings/config-update';
import { countDeploymentsByConnection } from '../provider-connection/invalidity';
import type {
  ProviderConnectionData,
  ProviderNotice,
} from '../provider-connection/useProviderConnectionData';

/**
 * 服务商详情的「添加模型 / 修改模型」写入面（spec 03 §6.1「记录即接入」、
 * spec hub-information-architecture §7.4）。
 *
 * 这里不断言内部状态，而是断言**真正发出的请求体**：数据源用真 api 客户端，只在最外层挡掉网络。
 * 「添加模型一次写入」「已添加的模型能改」这两件事成立与否，取决于请求长什么样，
 * 而不是取决于界面渲染了什么。
 */

const WRITE_TOKEN = 'a'.repeat(32);
const BASE = 'http://localhost:4877';

const connection: ProviderConnection = {
  connection_id: 'up_conn_chat1',
  display_name: '我的网关',
  protocol_adapter_id: 'openai-chat-completions-v1',
  base_url: 'https://api.example.com',
  has_credential: true,
  lifecycle: 'enabled',
  revision: 1,
  created_at: '2026-09-17T00:00:00.000Z',
  updated_at: '2026-09-17T00:00:00.000Z',
};

/**
 * 自建对话模型记录（记录即接入）：接口类型、能力值、档位与接入归属都在记录上，
 * 不再有并列的 ModelDeployment（对话族没有内置包）。
 */
const customModel: CustomChatModel = {
  model_id: 'my-llm',
  record_id: 'up_dep_rec1',
  connection_id: connection.connection_id,
  remote_model_id: 'my-llm',
  protocol_adapter_id: 'openai-chat-completions-v1',
  context_window_tokens: 300000,
  max_output_tokens: 8192,
  enabled_thinking_tiers: ['low'],
  default_thinking_tier: null,
  created_at: '2026-09-17T00:00:00.000Z',
};

const tierPool: ThinkingTierPool = {
  builtin: ['minimal', 'low', 'medium', 'high'],
  custom: [{ name: 'ultra', used_by_models: 0 }],
};

/**
 * 生成族服务商与它的已装包模型：与上面的对话服务商并存于同一份数据源，用来核对两种形态默认各归其行。
 * 协议适配器取 `openai-image-v1`（registry 里 family 为 generation），判族只认连接协议。
 * 已装包模型的接入载体仍是 ModelDeployment（自建模型记录不产生 Deployment，spec 03 §6.1）。
 */
const generationConnection: ProviderConnection = {
  ...connection,
  connection_id: 'up_conn_gen1',
  display_name: '我的绘图服务',
  protocol_adapter_id: 'openai-image-v1',
};

const generationDeployment: ModelDeployment = {
  deployment_id: 'up_dep_gen1',
  model_id: 'gpt-image-2',
  connection_id: generationConnection.connection_id,
  remote_model_id: 'gpt-image-2',
  created_at: '2026-09-17T00:00:00.000Z',
  updated_at: '2026-09-17T00:00:00.000Z',
};

/** 生成连接合并弹窗「软件自带的模型」区块的一条候选（已装能力包模型，尚未添加到本服务商） */
const generationCandidate: ExecutableModelDirectoryEntry = {
  model_id: 'second-image-model',
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: { input_modalities: ['text'], output_modalities: ['image'] },
  parameter_schema: { fields: [], required_fields: [] },
  deployment: {
    has_active_deployment: false,
    active_deployment_id: null,
    deployable: false,
    failure_code: 'no_active_deployment',
  },
};

/** 被 mock 的数据源；用例的 Harness 每次渲染把它刷成当前值。 */
const stateRef = vi.hoisted(() => ({ current: null as ProviderConnectionData | null }));

vi.mock('../provider-connection/ProviderDataContext', () => ({
  useProviderData: (): ProviderConnectionData => {
    if (stateRef.current === null) throw new Error('用例没有装载数据源');
    return stateRef.current;
  },
}));

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * 按路径给响应：写接口的响应体由契约 schema 在客户端 parse，形状不对会直接失败。
 *
 * `failDelete` 让删除接口返回失败：保护「从弹层发起的写入失败时，原因出现在弹层里」
 * ——分区顶部的提示条在弹层期间被遮罩挡住，只发到那里等于用户点了没反应。
 * `conflictCreate` 让创建接口返回 409：保护「重名由后端兜底时，前端给可读的冲突提示」。
 */
const stubFetch = (
  {
    failDelete = false,
    failBind = false,
    failCreateProvider = false,
    conflictCreate = false,
  }: { failDelete?: boolean; failBind?: boolean; failCreateProvider?: boolean; conflictCreate?: boolean } = {},
): FetchMock => {
  const mock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async (input, init) => {
      const url = String(input);
      const failing = failDelete && init?.method === 'DELETE';
      if (url.includes('/api/config')) {
        return jsonResponse({
          // 与真实响应同形：config 是整份本机配置的镜像，没设默认时这两个键就是 null。
          // 用空对象打桩会放过「schema 只写了 optional、接不住 null」这类契约裂缝。
          config: { agentDefaultModelId: null, generationDefaultModelId: null },
          resolved: {
            preferredPort: 0,
            logLevel: 'info',
            maxUploadSize: 1,
            maxMediaSize: 1,
            maxBatchTasks: 30,
            expandInlineParamsOnStartup: false,
            agentDefaultModelId: null,
            generationDefaultModelId: null,
            allowedRemoteHosts: [],
            proxyMode: 'system',
            proxyUrl: null,
          },
          server: { port: null, baseUrl: null },
        });
      }
      if (url.includes('/api/provider-connections') && init?.method === 'POST') {
        return failCreateProvider
          ? jsonResponse({ error: { code: 'internal', message: '拒绝' } }, 500)
          : jsonResponse({ connection: { ...connection, connection_id: 'up_conn_new1' } });
      }
      if (url.includes('/api/provider-connections/') && url.endsWith('/credential') && init?.method === 'PUT') {
        // 添加服务商后的密钥写入（两次调用中的第二次）：回连接成功同形
        return jsonResponse({ connection: { ...connection, connection_id: 'up_conn_new1', has_credential: true } });
      }
      if (url.includes('/api/thinking-tiers')) {
        // 删除的响应体是「级联摘掉了几个模型上的这个档位」，与读池子不同
        if (init?.method === 'DELETE') {
          return failing
            ? jsonResponse({ error: { code: 'internal', message: '拒绝' } }, 500)
            : jsonResponse({ removed_from_models: 0 });
        }
        return jsonResponse({ pool: { builtin: tierPool.builtin, custom: [{ name: 'ultra', used_by_models: 0 }] } });
      }
      if (url.includes('/api/custom-chat-models')) {
        if (init?.method === 'POST') {
          if (conflictCreate) {
            return jsonResponse({ message: '已经添加过这个模型了' }, 409);
          }
          const body = JSON.parse(String(init.body)) as {
            model_id: string;
            connection_id: string;
            context_window_tokens?: number;
            max_output_tokens?: number | null;
          };
          return jsonResponse({
            model: {
              ...body,
              record_id: 'up_dep_rec_new1',
              remote_model_id: body.model_id,
              enabled_thinking_tiers: [],
              default_thinking_tier: null,
              created_at: '2026-09-25T00:00:00.000Z',
            },
          });
        }
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as Partial<CustomChatModel>;
          return jsonResponse({ model: { ...customModel, ...body } });
        }
        if (init?.method === 'DELETE') {
          return failing
            ? jsonResponse({ error: { code: 'internal', message: '拒绝' } }, 500)
            : jsonResponse({ model_id: customModel.model_id });
        }
        return jsonResponse({ models: [customModel] });
      }
      if (url.includes('/api/model-deployments')) {
        if (failBind && init?.method === 'POST') {
          return jsonResponse({ error: { code: 'internal', message: '拒绝' } }, 500);
        }
        return jsonResponse({
          deployment: { ...generationDeployment, deployment_id: init?.method === 'POST' ? 'up_dep_new1' : generationDeployment.deployment_id },
        });
      }
      if (url.includes('/api/active-routes')) return jsonResponse({ model_id: 'gpt-image-2', deployment_id: 'up_dep_new1' });
      throw new Error(`未预期的请求：${init?.method ?? 'GET'} ${url}`);
    },
  );
  vi.stubGlobal('fetch', mock);
  return mock;
};

/** 数据源 + 提示条状态：提示是分区自己持有的状态，桩里也要能变，否则提示类断言看不到东西。 */
function Harness({ overrides }: { overrides: Partial<ProviderConnectionData> }) {
  const [notice, setNotice] = useState<ProviderNotice | null>(null);
  stateRef.current = {
    api: createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN)),
    connections: [connection],
    deployments: [],
    activeRoutes: { 'my-llm': customModel.record_id },
    activeDeploymentIds: new Set([customModel.record_id]),
    connectionById: new Map([[connection.connection_id, connection]]),
    deploymentCountByConnection: new Map<string, number>(),
    catalog: [],
    chatCatalog: [],
    catalogUnavailable: false,
    chatCatalogUnavailable: false,
    thinkingTierPool: tierPool,
    thinkingTierPoolUnavailable: false,
    customChatModels: [customModel],
    customChatModelsUnavailable: false,
    customGenerationModels: [],
    customGenerationModelsUnavailable: false,
    agentDefaultModelId: null,
    // 与 hook 同一条写入路径：配置写入体经过 buildConfigUpdatePayload 补全，测试因此能核对真实请求体
    saveAgentDefaultModel: async (modelId) => {
      await createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN)).saveConfig(
        buildConfigUpdatePayload({ agentDefaultModelId: modelId }),
      );
    },
    generationDefaultModelId: null,
    saveGenerationDefaultModel: async (modelId) => {
      await createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN)).saveConfig(
        buildConfigUpdatePayload({ generationDefaultModelId: modelId }),
      );
    },
    loading: false,
    notice,
    setNotice,
    reload: async () => undefined,
    ...overrides,
  };
  return <ProviderSection />;
}

const openDetail = (overrides: Partial<ProviderConnectionData> = {}): void => {
  render(<Harness overrides={overrides} />);
  fireEvent.click(screen.getByText('我的网关'));
};

/**
 * 打开生成族服务商的详情：左列两个服务商都在，先点生成族那个。
 *
 * 只渲染被选中连接的模型行，所以这一个视图里只有生成族行——「生成族行不该出现 Agent 默认入口」
 * 这类否定断言因此不会被另一族的行串台。
 */
const openGenerationDetail = (overrides: Partial<ProviderConnectionData> = {}): void => {
  render(
    <Harness
      overrides={{
        connections: [connection, generationConnection],
        deployments: [generationDeployment],
        activeRoutes: {
          'my-llm': customModel.record_id,
          'gpt-image-2': generationDeployment.deployment_id,
        },
        ...overrides,
      }}
    />,
  );
  fireEvent.click(screen.getByText('我的绘图服务'));
};

/** 模型配置弹层内的元素。确认弹层会叠在它上面，那时按标题取另一个（`confirmDialog`）。 */
const dialog = () => within(screen.getByRole('dialog', { name: /^修改「|^添加模型到/ }));

/** 叠在模型配置弹层上的二次确认弹层：按标题指认，避免与下层的弹层混淆。 */
const confirmDialog = (title: string) => within(screen.getByRole('dialog', { name: title }));

/**
 * 「添加模型」恒先出二级选择（2026-09-29 起连接级预选摘除）：选「对话模型」开自建表单弹层。
 * 下拉对键盘可见：键盘打开（Radix 菜单不响应 jsdom 里的裸 click）。
 */
const openChatModelDialog = (): void => {
  fireEvent.keyDown(screen.getByRole('button', { name: '添加模型' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('menuitem', { name: '对话模型' }));
};

/** 二级选择选「生成模型」开合并弹窗。 */
const openGenerationModelDialog = (): void => {
  fireEvent.keyDown(screen.getByRole('button', { name: '添加模型' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('menuitem', { name: '生成模型' }));
};

/** 在弹层里选「接口类型」（下拉渲染在 portal，选项按 body 级查询；jsdom 无 PointerEvent：键盘开下拉，click 选中）。 */
const chooseDialogAdapter = (optionName: string): void => {
  fireEvent.keyDown(dialog().getByLabelText('接口类型'), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: optionName }));
};

const bodyOf = (mock: FetchMock, match: string, method: string): unknown => {
  const call = mock.mock.calls.find(([input, init]) => String(input).includes(match) && init?.method === method);
  if (call === undefined) throw new Error(`没有发出 ${method} ${match}`);
  return JSON.parse(String(call[1]?.body));
};

describe('服务商详情：添加模型（一次写入）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('添加模型发一次创建请求：能力值与接入归属同一次落库，不再串联接入与设为当前使用', async () => {
    const fetchFn = stubFetch();
    openDetail();

    openChatModelDialog();
    chooseDialogAdapter('OpenAI Chat Completions');
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'new-llm' } });
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    expect(bodyOf(fetchFn, '/api/custom-chat-models', 'POST')).toEqual({
      model_id: 'new-llm',
      connection_id: connection.connection_id,
      protocol_adapter_id: 'openai-chat-completions-v1',
      context_window_tokens: 128000,
      max_output_tokens: null,
    });
    // active 接入由后端在创建内写入：不再有 createModelDeployment / setActiveRoute 跟进
    expect(fetchFn.mock.calls.some(([input, init]) => String(input).includes('/api/model-deployments') && init?.method === 'POST')).toBe(false);
    expect(fetchFn.mock.calls.some(([input, init]) => String(input).includes('/api/active-routes') && init?.method === 'PUT')).toBe(false);
  });

  it('表单勾了思考档位：档位两字段随创建请求一次落库，不再补第二次写入', async () => {
    const fetchFn = stubFetch();
    openDetail();

    openChatModelDialog();
    chooseDialogAdapter('OpenAI Chat Completions');
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'new-llm' } });
    fireEvent.click(dialog().getByRole('button', { name: '启用档位「medium」' }));
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    expect(bodyOf(fetchFn, '/api/custom-chat-models', 'POST')).toEqual({
      model_id: 'new-llm',
      connection_id: connection.connection_id,
      protocol_adapter_id: 'openai-chat-completions-v1',
      context_window_tokens: 128000,
      max_output_tokens: null,
      enabled_thinking_tiers: ['medium'],
      default_thinking_tier: null,
    });
    // 没有第二次写入：档位随创建一次落库，不再有「创建后补 PUT」的中间态
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('要添加的模型已经在这个服务商上：提交前说清，不发写入请求', async () => {
    const fetchFn = stubFetch();
    openDetail();

    openChatModelDialog();
    chooseDialogAdapter('OpenAI Chat Completions');
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-llm' } });
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    // 用户的目标（这个模型在这个服务商上）已经达成，写入只会撞上重名：
    // 与其让他对着一句「请重试」反复点，不如在这里说清并指到改配置的入口
    await waitFor(() => {
      expect(dialog().getByRole('alert')).toHaveTextContent(
        '「my-llm」已经添加到这个服务商了。想改它，关掉这个窗口后在列表里点「修改」。',
      );
    });
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('重名撞上后端 409 兜底（名字被别的连接或已装模型占了）：给「换名字」的可读提示，不落进请重试', async () => {
    stubFetch({ conflictCreate: true });
    openDetail();

    openChatModelDialog();
    chooseDialogAdapter('OpenAI Chat Completions');
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'taken-llm' } });
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(dialog().getByRole('alert')).toHaveTextContent(
        '「taken-llm」这个名字已经有模型在用了，换一个模型 ID 再添加。',
      );
    });
    expect(screen.getByRole('dialog', { name: '添加模型到「我的网关」' })).toBeInTheDocument();
  });

  it('「添加档位」把自定义档位写进池子，并随创建请求一次启用在该模型上', async () => {
    const fetchFn = stubFetch();
    openDetail();

    openChatModelDialog();
    chooseDialogAdapter('OpenAI Chat Completions');
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'new-llm' } });
    fireEvent.change(dialog().getByLabelText('自定义档位名'), { target: { value: 'ultra' } });
    fireEvent.click(dialog().getByRole('button', { name: '添加档位' }));

    await waitFor(() => {
      expect(bodyOf(fetchFn, '/api/thinking-tiers', 'POST')).toEqual({ name: 'ultra' });
    });

    fireEvent.click(dialog().getByRole('button', { name: '添加' }));
    await waitFor(() => {
      expect(bodyOf(fetchFn, '/api/custom-chat-models', 'POST')).toEqual({
        model_id: 'new-llm',
        connection_id: connection.connection_id,
        protocol_adapter_id: 'openai-chat-completions-v1',
        context_window_tokens: 128000,
        max_output_tokens: null,
        enabled_thinking_tiers: ['ultra'],
        default_thinking_tier: null,
      });
    });
  });
});

describe('服务商详情：修改已添加的模型', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('「修改」回填该模型的能力与档位，保存走一次 PUT 整体替换（能力 + 档位一起）', async () => {
    const fetchFn = stubFetch();
    openDetail();

    fireEvent.click(screen.getByRole('button', { name: '修改「my-llm」的配置' }));
    expect((dialog().getByLabelText('上下文窗口') as HTMLInputElement).value).toBe('300000');
    // 已启用列表按模型记录回填（顺序即创作面展示顺序）
    expect(dialog().getByRole('button', { name: '拖动排序「low」' })).toBeInTheDocument();

    fireEvent.click(dialog().getByRole('button', { name: '启用档位「medium」' }));
    fireEvent.change(dialog().getByLabelText('最大输出 token'), { target: { value: '16384' } });
    fireEvent.click(dialog().getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true);
    });

    expect(bodyOf(fetchFn, `/api/custom-chat-models/${customModel.model_id}`, 'PUT')).toEqual({
      context_window_tokens: 300000,
      max_output_tokens: 16384,
      enabled_thinking_tiers: ['low', 'medium'],
      default_thinking_tier: null,
    });
    // 没有第二次写入：档位不再落接入（ModelDeployment 档位字段已退役）
    expect(fetchFn.mock.calls.some(([input, init]) => String(input).includes('/api/model-deployments') && init?.method === 'PUT')).toBe(false);
  });

  it('连接已停用时改模型配置：提交前拦下并指向「启用」，不发写入请求', async () => {
    const fetchFn = stubFetch();
    openDetail({ connections: [{ ...connection, lifecycle: 'disabled' }] });

    fireEvent.click(screen.getByRole('button', { name: '修改「my-llm」的配置' }));
    fireEvent.click(dialog().getByRole('button', { name: '保存' }));

    // 停用的连接上保存必然失败（后端要求 enabled），与添加一样提交前拦下、
    // 指向同一屏可点的「启用」；入口保留——停用可恢复
    await waitFor(() => {
      expect(dialog().getByRole('alert')).toHaveTextContent(
        '「我的网关」已停用。关掉这个窗口后点「启用」，再回来改配置。',
      );
    });
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('「设为默认」把该模型写进 Agent 默认配置，其余配置不动', async () => {
    const fetchFn = stubFetch();
    openDetail();

    fireEvent.click(screen.getByRole('button', { name: '把「my-llm」设为 Agent 默认模型' }));

    await waitFor(() => {
      expect(fetchFn.mock.calls.some(([input, init]) => String(input).includes('/api/config') && init?.method === 'PUT')).toBe(true);
    });
    // 未提供的字段补 undefined 后被 JSON 序列化丢弃：写入体只带本次要改的配置项，不覆盖其余设置
    expect(bodyOf(fetchFn, '/api/config', 'PUT')).toEqual({ agentDefaultModelId: 'my-llm' });
  });

  it('Agent 默认的说明挂在它讲的那个徽章上，不挂在「模型列表」标题上', () => {
    stubFetch();
    openDetail({ agentDefaultModelId: customModel.model_id });

    // 「模型列表」是区块标题，不是这段说明讲的对象：标题旁不该出现它的说明入口
    expect(screen.queryByRole('button', { name: 'Agent 默认模型说明' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '「my-llm」作为 Agent 默认模型说明' })).toBeInTheDocument();
  });
});

describe('服务商详情：生成默认模型', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('两种形态默认各归其族：生成族行只有生成默认入口，对话族行只有 Agent 默认入口', () => {
    stubFetch();
    openGenerationDetail();

    expect(screen.getByRole('button', { name: '把「gpt-image-2」设为生成默认模型' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /设为 Agent 默认模型$/ })).not.toBeInTheDocument();

    // 换成对话族服务商，同一屏里两种入口互换
    fireEvent.click(screen.getByText('我的网关'));

    expect(screen.getByRole('button', { name: '把「my-llm」设为 Agent 默认模型' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /设为生成默认模型$/ })).not.toBeInTheDocument();
  });

  it('「设为生成默认」把该模型写进生成默认配置，其余配置不动', async () => {
    const fetchFn = stubFetch();
    openGenerationDetail();

    fireEvent.click(screen.getByRole('button', { name: '把「gpt-image-2」设为生成默认模型' }));

    // 写入确实成功了（成功提示出现），而不是「发了请求但没落地」
    await waitFor(() => {
      expect(screen.getByText('已把「gpt-image-2」设为生成默认模型')).toBeInTheDocument();
    });
    // 未提供的字段补 undefined 后被 JSON 序列化丢弃：写入体只带本次要改的配置项，不覆盖其余设置
    expect(bodyOf(fetchFn, '/api/config', 'PUT')).toEqual({ generationDefaultModelId: 'gpt-image-2' });
  });

  it('「取消默认」写的是 null，而不是不发这个字段', async () => {
    const fetchFn = stubFetch();
    openGenerationDetail({ generationDefaultModelId: generationDeployment.model_id });

    fireEvent.click(screen.getByRole('button', { name: '取消「gpt-image-2」作为生成默认模型' }));

    await waitFor(() => {
      expect(screen.getByText('已取消「gpt-image-2」的生成默认模型')).toBeInTheDocument();
    });
    expect(bodyOf(fetchFn, '/api/config', 'PUT')).toEqual({ generationDefaultModelId: null });
  });

  it('已设为生成默认的行：徽章、说明与「取消默认」都挂在那一行上', () => {
    stubFetch();
    openGenerationDetail({ generationDefaultModelId: generationDeployment.model_id });

    expect(screen.getByText('生成默认')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '「gpt-image-2」作为生成默认模型说明' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消「gpt-image-2」作为生成默认模型' })).toHaveTextContent(
      '取消默认',
    );
  });
});

describe('服务商详情：删除自建模型', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('「删除模型」删的是模型本身：确认里说明模型会消失及其影响，删成后关掉配置弹层', async () => {
    const fetchFn = stubFetch();
    openDetail();

    fireEvent.click(screen.getByRole('button', { name: '修改「my-llm」的配置' }));
    fireEvent.click(dialog().getByRole('button', { name: '删除模型' }));

    // 影响面写在确认文案里：模型本身将消失（从模型列表与 Agent 里），不再有接入计数
    expect(
      confirmDialog('删除模型').getByText('确定删除「my-llm」吗？删除后它会从模型列表里消失，Agent 也不再能用它。'),
    ).toBeInTheDocument();
    fireEvent.click(confirmDialog('删除模型').getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(
        fetchFn.mock.calls.some(
          ([input, init]) =>
            String(input).includes(`/api/custom-chat-models/${customModel.model_id}`) && init?.method === 'DELETE',
        ),
      ).toBe(true);
    });
    // 删掉的正是配置弹层里那个模型：成功后弹层关闭（它对应的行已经没有了）
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('取消确认时不发删除请求，配置弹层留着（填的内容不丢）', async () => {
    const fetchFn = stubFetch();
    openDetail();

    fireEvent.click(screen.getByRole('button', { name: '修改「my-llm」的配置' }));
    fireEvent.click(dialog().getByRole('button', { name: '删除模型' }));
    fireEvent.click(confirmDialog('删除模型').getByRole('button', { name: '取消' }));

    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    expect(screen.getByRole('dialog', { name: '修改「my-llm」的模型配置' })).toBeInTheDocument();
  });

  it('删除失败时把原因写进弹层（顶部提示条被遮罩挡住，用户看不到），弹层留着', async () => {
    stubFetch({ failDelete: true });
    openDetail();

    fireEvent.click(screen.getByRole('button', { name: '修改「my-llm」的配置' }));
    fireEvent.click(dialog().getByRole('button', { name: '删除模型' }));
    fireEvent.click(confirmDialog('删除模型').getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(dialog().getByRole('alert')).toHaveTextContent('没能删除模型，请重试');
    });
    expect(screen.getByRole('dialog', { name: '修改「my-llm」的模型配置' })).toBeInTheDocument();
  });
});

describe('服务商详情：删除服务商与密钥的影响面', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('删除服务商：软件自带与在这里添加的两种来源分开点名（都按「删除」说，不并成一个数）', () => {
    stubFetch();
    openDetail({
      connections: [connection, generationConnection],
      deployments: [generationDeployment],
      deploymentCountByConnection: countDeploymentsByConnection([generationDeployment]),
      customGenerationModels: [
        {
          model_id: 'my-image-model',
          record_id: 'up_dep_rec2',
          connection_id: generationConnection.connection_id,
          remote_model_id: 'my-image-model',
          family_adapter_id: 'openai-image-v1',
          supports_reference_image: false,
          parameter_overrides: { official: [], custom: [] },
          created_at: '2026-09-25T00:00:00.000Z',
        },
      ],
    });
    fireEvent.click(screen.getByText('我的绘图服务'));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(
      screen.getByText(
        '确定删除「我的绘图服务」吗？删除后，在这里添加的 1 个模型会一并删除；软件自带的 1 个模型之后可添加到其他服务商。',
      ),
    ).toBeInTheDocument();
  });

  it('删除服务商只有自建记录时：影响面只说删除', () => {
    stubFetch();
    openDetail();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(
      screen.getByText('确定删除「我的网关」吗？在这里添加的 1 个模型会一并删除。'),
    ).toBeInTheDocument();
  });

  it('删除密钥：接入与自建记录都只是不可用，合并成一个数', () => {
    stubFetch();
    openDetail();
    fireEvent.click(screen.getByRole('button', { name: '删除密钥' }));

    expect(
      screen.getByText('确定删除「我的网关」的密钥吗？它下面的 1 个模型会变成不可用。'),
    ).toBeInTheDocument();
  });
});

describe('服务商详情：添加自带模型的失败提示（生成连接，已装包模型）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('自带区块默认展开；添加失败时把原因写进弹层（顶部提示条被遮罩挡住，用户看不到）', async () => {
    stubFetch({ failBind: true });
    openGenerationDetail({ catalog: [generationCandidate] });

    openGenerationModelDialog();
    const bindDialog = within(screen.getByRole('dialog', { name: '添加模型到「我的绘图服务」' }));
    fireEvent.click(bindDialog.getByLabelText('添加 second-image-model'));
    fireEvent.click(bindDialog.getByRole('button', { name: '添加 1 个模型' }));

    await waitFor(() => {
      expect(bindDialog.getByRole('alert')).toHaveTextContent('没能添加这个模型，请重试');
    });
    // 剩余理由要一并写出来：写入侧只剩「服务商不支持它」与「已经添加过了」，兜底只说「请重试」等于没说
    expect(bindDialog.getByRole('alert')).toHaveTextContent('这个服务商不支持它，或它已经添加过了');
    expect(screen.getByRole('dialog', { name: '添加模型到「我的绘图服务」' })).toBeInTheDocument();
  });

  it('添加失败后重新装载列表：批量里已加上的模型要随即退出候选', async () => {
    stubFetch({ failBind: true });
    const reload = vi.fn(async () => undefined);
    openGenerationDetail({ catalog: [generationCandidate], reload });

    openGenerationModelDialog();
    const bindDialog = within(screen.getByRole('dialog', { name: '添加模型到「我的绘图服务」' }));
    fireEvent.click(bindDialog.getByLabelText('添加 second-image-model'));
    fireEvent.click(bindDialog.getByRole('button', { name: '添加 1 个模型' }));

    await waitFor(() => {
      expect(reload).toHaveBeenCalled();
    });
  });

  it('连接没有密钥：提交前就拦下并给出插入密钥的路径，不发写入请求', async () => {
    const fetchFn = stubFetch();
    openGenerationDetail({
      connections: [{ ...generationConnection, has_credential: false }],
      deployments: [],
      activeRoutes: { 'my-llm': customModel.record_id },
      catalog: [generationCandidate],
    });

    openGenerationModelDialog();
    const bindDialog = within(screen.getByRole('dialog', { name: '添加模型到「我的绘图服务」' }));
    fireEvent.click(bindDialog.getByLabelText('添加 second-image-model'));
    fireEvent.click(bindDialog.getByRole('button', { name: '添加 1 个模型' }));

    // 弹层期间「插入密钥」被遮罩挡着，所以路径写成「关掉这个窗口后」
    await waitFor(() => {
      expect(bindDialog.getByRole('alert')).toHaveTextContent(
        '「我的绘图服务」还没插密钥。关掉这个窗口后点「插入密钥」，再回来添加模型。',
      );
    });
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('连接已停用：同样在提交前拦下，指向「启用」', async () => {
    const fetchFn = stubFetch();
    openGenerationDetail({
      connections: [{ ...generationConnection, lifecycle: 'disabled' }],
      deployments: [],
      activeRoutes: { 'my-llm': customModel.record_id },
      catalog: [generationCandidate],
    });

    openGenerationModelDialog();
    const bindDialog = within(screen.getByRole('dialog', { name: '添加模型到「我的绘图服务」' }));
    fireEvent.click(bindDialog.getByLabelText('添加 second-image-model'));
    fireEvent.click(bindDialog.getByRole('button', { name: '添加 1 个模型' }));

    await waitFor(() => {
      expect(bindDialog.getByRole('alert')).toHaveTextContent(
        '「我的绘图服务」已停用。关掉这个窗口后点「启用」，再回来添加模型。',
      );
    });
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('退役连接：添加与编辑入口都不渲染，「移除」与只读信息还在', () => {
    stubFetch();
    openDetail({
      connections: [{ ...connection, lifecycle: 'retired' }],
      activeRoutes: {},
    });

    // retired 与 disabled 对用户都是「已停用」，但只有前者没有可点的「启用」——
    // 没有恢复路径的状态不提供必然失败的入口，也不解释为什么没有（spec §7.5）
    expect(screen.queryByRole('button', { name: '启用' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加模型' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '修改「my-llm」的配置' })).not.toBeInTheDocument();
    // 自建记录行没有「移除」：记录即接入，摘掉接入等于删掉模型，那个动作在配置弹层里
    expect(screen.queryByRole('button', { name: '移除' })).not.toBeInTheDocument();
  });

  it('退役连接的已装包模型行塌缩单行只读：行内编辑排不渲染，模型 ID 纯文本可见（visual-design §8.6 律二）', () => {
    stubFetch();
    openGenerationDetail({
      connections: [connection, { ...generationConnection, lifecycle: 'retired' }],
    });

    // 行 2 整段不渲染：不出禁用态输入框（§7.5 编辑入口不提供），随行 2 走的动作一并消失
    expect(
      screen.queryByRole('textbox', { name: 'gpt-image-2 的服务商那边的模型 ID' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '移除' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '设为生成默认' })).not.toBeInTheDocument();
    // 行 1 只读投影仍在：模型 ID 以纯文本呈现（状态更诚实 + 密度对冲）
    expect(screen.getByText('gpt-image-2')).toBeInTheDocument();
  });
});

describe('服务商设置：添加服务商弹层', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('添加失败时把原因写进弹层（顶部提示条被遮罩挡住，用户看不到），弹层不关', async () => {
    const fetchFn = stubFetch({ failCreateProvider: true });
    render(<Harness overrides={{}} />);

    fireEvent.click(screen.getByRole('button', { name: '＋ 添加服务商' }));
    const addDialog = within(screen.getByRole('dialog', { name: '添加服务商' }));
    fireEvent.change(addDialog.getByLabelText('服务地址'), { target: { value: 'https://api.example.com' } });
    fireEvent.change(addDialog.getByLabelText('密钥'), { target: { value: 'sk-add-key' } });
    // 与已有服务商同址：只提醒不拦截（提示不在地址时出现）
    expect(addDialog.getByText('已有一个服务商在用这个服务地址。如果不是重复添加，继续保存即可')).toBeInTheDocument();
    // 表单里没有接口类型字段（2026-09-29 起摘除连接级预选）：填名称/地址/密钥即可提交
    expect(addDialog.getByRole('button', { name: '添加' })).toBeEnabled();
    fireEvent.click(addDialog.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(fetchFn.mock.calls.some(([input, init]) => String(input).includes('/api/provider-connections') && init?.method === 'POST')).toBe(true);
    });
    await waitFor(() => {
      expect(addDialog.getByRole('alert')).toHaveTextContent('没能添加服务商，请检查服务地址后重试');
    });
    // 失败不关弹层：填的地址和密钥都还在，原因看得见，改完可以直接再提交
    expect(screen.getByRole('dialog', { name: '添加服务商' })).toBeInTheDocument();
    expect((addDialog.getByLabelText('服务地址') as HTMLInputElement).value).toBe('https://api.example.com');
    expect((addDialog.getByLabelText('密钥') as HTMLInputElement).value).toBe('sk-add-key');
  });

  it('创建体只有名称与地址（接口类型不在连接上配置）；与已有服务商同址的提醒不拦提交', async () => {
    const fetchFn = stubFetch();
    render(<Harness overrides={{}} />);

    fireEvent.click(screen.getByRole('button', { name: '＋ 添加服务商' }));
    const addDialog = within(screen.getByRole('dialog', { name: '添加服务商' }));
    fireEvent.change(addDialog.getByLabelText('名称'), { target: { value: '另一个网关' } });
    fireEvent.change(addDialog.getByLabelText('服务地址'), { target: { value: 'https://other.example.com/v1' } });
    fireEvent.change(addDialog.getByLabelText('密钥'), { target: { value: 'sk-add-key' } });
    // 地址不同：没有重复提醒
    expect(addDialog.queryByText('已有一个服务商在用这个服务地址。如果不是重复添加，继续保存即可')).not.toBeInTheDocument();
    fireEvent.click(addDialog.getByRole('button', { name: '添加' }));

    await waitFor(() => {
      // 连接级接口类型已摘除：创建体不再携带 protocol_adapter_id
      expect(bodyOf(fetchFn, '/api/provider-connections', 'POST')).toEqual({
        display_name: '另一个网关',
        base_url: 'https://other.example.com/v1',
      });
    });
  });
});

describe('服务商详情：自带模型进度行只读报数', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('进度行只读报自带与可用两个数，不出快捷按钮（添加走详情里唯一的「添加模型」）', () => {
    stubFetch();
    openGenerationDetail({ catalog: [generationCandidate] });

    expect(screen.getByText('软件自带 1 个模型，当前可用 0 个')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /待就绪/ })).not.toBeInTheDocument();
  });

  it('进度行恒按可执行目录报数：对话记录所在的连接也一样（连接级接口类型已摘除，不再按协议分流）', () => {
    stubFetch();
    openDetail({ catalog: [generationCandidate] });

    expect(screen.getByText('软件自带 1 个模型，当前可用 0 个')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加模型' })).toBeInTheDocument();
  });
});

describe('服务商详情：删除自定义档位', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('从档位字段删出池子：确认里说明几个模型会失去它，删完配置弹层留着', async () => {
    const fetchFn = stubFetch();
    // 影响面计数来自池子（这个档位正被 2 个模型用着）
    openDetail({ thinkingTierPool: { builtin: tierPool.builtin, custom: [{ name: 'ultra', used_by_models: 2 }] } });

    fireEvent.click(screen.getByRole('button', { name: '修改「my-llm」的配置' }));
    fireEvent.click(dialog().getByRole('button', { name: '删除档位「ultra」' }));

    expect(
      confirmDialog('删除档位').getByText('确定删除档位「ultra」吗？正在用它的 2 个模型会失去这个档位。'),
    ).toBeInTheDocument();
    fireEvent.click(confirmDialog('删除档位').getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(
        fetchFn.mock.calls.some(
          ([input, init]) => String(input).includes('/api/thinking-tiers/ultra') && init?.method === 'DELETE',
        ),
      ).toBe(true);
    });
    // 删的是池子里的档位、不是当前模型的配置：弹层留着，用户还能接着改这个模型
    expect(screen.getByRole('dialog', { name: '修改「my-llm」的模型配置' })).toBeInTheDocument();
  });
});
