import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUB_LOCAL_WRITE_TOKEN_HEADER } from '@iart/contracts';
import { createHubApiClient } from '../hub-api';
import { createHubHttpClient } from '../../adapters/http-client';

/**
 * hub-api ProviderConnection / active route / 可执行目录方法的
 * 请求构造 + 响应 schema parse 单测（spec 03 §4/§5/§6 + spec 45 §3）。
 *
 * 2026-10-19 部署载体退场：`listModelDeployments` / `createModelDeployment` /
 * `updateModelDeployment` / `deleteModelDeployment` 四个客户端方法与对应的
 * `/api/model-deployments` 端点一并删除（spec 03 §12 PC-14），本文件里的模型接入 PUT 用例
 * 随之退场——它保护的「deployment 体只透传两个字段」已没有对应实现。
 */

const WRITE_TOKEN = 'a'.repeat(32);
const BASE = 'http://localhost:4877';

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fetchMock = (handler: () => Promise<Response>): FetchMock => {
  const mock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(handler);
  vi.stubGlobal('fetch', mock);
  return mock;
};

const okConnection = {
  connection_id: 'up_conn_test1',
  display_name: '团队网关',
  protocol_adapter_id: 'openai-image-v1',
  base_url: 'https://api.example.com',
  has_credential: true,
  lifecycle: 'enabled',
  revision: 1,
  created_at: '2026-08-20T08:00:00.000Z',
  updated_at: '2026-08-20T09:00:00.000Z',
};

describe('hub api provider 边界', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('active route PUT：只透传 deployment_id（接入目标即记录 id），并带写令牌', async () => {
    const fetchFn = fetchMock(async () => jsonResponse({ model_id: 'my-llm', deployment_id: 'up_dep_rec1' }));

    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
    const result = await api.setActiveRoute('my-llm', 'up_dep_rec1');

    expect(result.deployment_id).toBe('up_dep_rec1');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`${BASE}/api/active-routes/my-llm`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ deployment_id: 'up_dep_rec1' });
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.[HUB_LOCAL_WRITE_TOKEN_HEADER]).toBe(WRITE_TOKEN);
  });

  it('setProviderConnectionLifecycle PUT lifecycle 端点并 parse connection', async () => {
    const fetchFn = fetchMock(async () => jsonResponse({ connection: { ...okConnection, lifecycle: 'retired' } }));

    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
    const result = await api.setProviderConnectionLifecycle('up_conn_test1', 'retired');

    expect(result.connection.lifecycle).toBe('retired');
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`${BASE}/api/provider-connections/up_conn_test1/lifecycle`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ lifecycle: 'retired' });
  });

  it('removeProviderConnectionCredential DELETE credential 端点并 parse has_credential=false', async () => {
    const fetchFn = fetchMock(async () => jsonResponse({ connection: { ...okConnection, has_credential: false }, has_credential: false }));

    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
    const result = await api.removeProviderConnectionCredential('up_conn_test1');

    expect(result.has_credential).toBe(false);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`${BASE}/api/provider-connections/up_conn_test1/credential`);
    expect(init?.method).toBe('DELETE');
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.[HUB_LOCAL_WRITE_TOKEN_HEADER]).toBe(WRITE_TOKEN);
  });

  it('listExecutableModelCatalog GET 端点并 parse contracts 嵌套 models 数组', async () => {
    const fetchFn = fetchMock(async () => jsonResponse({
      models: [
        {
          model_id: 'gpt-image-1',
          model_version: '2',
          default_task_type: 'image',
          display_order: 100,
          capability: {
            input_modalities: ['text'],
            output_modalities: ['image'],
            supports_multi_image: false,
            supports_reference_media: true,
          },
          parameter_schema: {
            fields: [{ fieldKey: 'size', label: '尺寸', component: 'select', required: false }],
            required_fields: [],
          },
          deployment: {
            has_active_deployment: true,
            active_deployment_id: 'up_dep_test1',
            deployable: true,
            failure_code: 'none',
          },
        },
        {
          model_id: 'gennano-pro',
          model_version: '1',
          default_task_type: 'image',
          capability: {
            input_modalities: ['text'],
            output_modalities: ['image'],
            supports_multi_image: false,
            supports_reference_media: true,
          },
          parameter_schema: { fields: [], required_fields: [] },
          deployment: {
            has_active_deployment: false,
            active_deployment_id: null,
            deployable: false,
            failure_code: 'no_active_deployment',
          },
        },
      ],
    }));

    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
    const result = await api.listExecutableModelCatalog(undefined);

    expect(result.models).toHaveLength(2);
    expect(result.models[0]?.model_id).toBe('gpt-image-1');
    expect(result.models[0]?.deployment.failure_code).toBe('none');
    expect(result.models[1]?.deployment.failure_code).toBe('no_active_deployment');
    const [url] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`${BASE}/api/executable-model-catalog`);
  });

  it('listChatModelCatalog GET 独立端点并 parse contracts 嵌套 models 数组', async () => {
    const fetchFn = fetchMock(async () => jsonResponse({
      models: [
        {
          model_id: 'my-llm',
          model_version: '1.0.0',
          default_task_type: 'text',
          display_order: 50,
          capability: {
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            supports_multi_image: false,
            supports_reference_media: false,
          },
          parameter_schema: { fields: [], required_fields: [] },
          thinking_tiers: ['low', 'high'],
          default_thinking_tier: 'high',
          deployment: {
            has_active_deployment: false,
            active_deployment_id: null,
            deployable: false,
            failure_code: 'no_active_deployment',
          },
        },
      ],
    }));

    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
    const result = await api.listChatModelCatalog(undefined);

    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.model_id).toBe('my-llm');
    expect(result.models[0]?.parameter_schema.fields).toEqual([]);
    expect(result.models[0]?.thinking_tiers).toEqual(['low', 'high']);
    const [url] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`${BASE}/api/chat-model-catalog`);
  });

  it('后端确定性错误 message 透传（不吞掉），见 HubHttpError', async () => {
    fetchMock(async () => jsonResponse({ message: '该连接存在活跃凭证租约，请先退役' }, 409));

    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
    await expect(api.deleteProviderConnection('up_conn_busy')).rejects.toThrow(
      /该连接存在活跃凭证租约，请先退役/,
    );
  });

  it('思考档位池：GET 读池子、POST 加自定义档、DELETE 删除并带写令牌', async () => {
    const pool = {
      pool: {
        builtin: ['minimal', 'low', 'medium', 'high'],
        custom: [{ name: 'ultra', used_by_models: 2 }],
      },
    };
    const fetchFn = fetchMock(async () => jsonResponse(pool));

    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
    const listed = await api.listThinkingTiers(undefined);
    expect(listed.pool.builtin).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(listed.pool.custom).toEqual([{ name: 'ultra', used_by_models: 2 }]);
    const [listUrl, listInit] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(listUrl).toBe(`${BASE}/api/thinking-tiers`);
    expect(listInit?.method).toBeUndefined();
    expect((listInit?.headers as Record<string, string> | undefined)?.[HUB_LOCAL_WRITE_TOKEN_HEADER]).toBeUndefined();

    await api.addThinkingTier('ultra');
    const [addUrl, addInit] = fetchFn.mock.calls[1] as [string, RequestInit | undefined];
    expect(addUrl).toBe(`${BASE}/api/thinking-tiers`);
    expect(addInit?.method).toBe('POST');
    expect(addInit?.body).toBe(JSON.stringify({ name: 'ultra' }));
    expect((addInit?.headers as Record<string, string> | undefined)?.[HUB_LOCAL_WRITE_TOKEN_HEADER]).toBe(WRITE_TOKEN);

    fetchFn.mockImplementation(async () => jsonResponse({ removed_from_models: 2 }));
    const removal = await api.removeThinkingTier('ultra');
    expect(removal.removed_from_models).toBe(2);
    const [deleteUrl, deleteInit] = fetchFn.mock.calls[2] as [string, RequestInit | undefined];
    expect(deleteUrl).toBe(`${BASE}/api/thinking-tiers/ultra`);
    expect(deleteInit?.method).toBe('DELETE');
  });

  it('思考档位池：响应缺字段时 parse 失败（契约边界不放行）', async () => {
    fetchMock(async () => jsonResponse({ pool: { builtin: ['low'] } }));

    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
    await expect(api.listThinkingTiers(undefined)).rejects.toThrow();
  });

  it('自建对话模型：GET 列表、POST 添加（含接入归属与接口格式）、PUT 四字段整体替换、DELETE 删除并带写令牌', async () => {
    // 与新契约同形：记录即接入（record_id/connection_id/remote_model_id 内嵌，档位随记录走）；
    // 2026-09-26 起协议归属模型级，记录自带 protocol_adapter_id
    const model = {
      model_id: 'my-llm',
      record_id: 'up_dep_rec1',
      connection_id: 'up_conn_test1',
      remote_model_id: 'my-llm',
      protocol_adapter_id: 'openai-chat-completions-v1',
      context_window_tokens: 300000,
      max_output_tokens: 8192,
      enabled_thinking_tiers: ['low'],
      default_thinking_tier: null,
      created_at: '2026-09-17T00:00:00.000Z',
    };
    const fetchFn = fetchMock(async () => jsonResponse({ models: [model] }));

    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
    const listed = await api.listCustomChatModels(undefined);
    expect(listed.models).toEqual([model]);
    const [listUrl, listInit] = fetchFn.mock.calls[0] as [string, RequestInit | undefined];
    expect(listUrl).toBe(`${BASE}/api/custom-chat-models`);
    expect(listInit?.method).toBeUndefined();
    expect((listInit?.headers as Record<string, string> | undefined)?.[HUB_LOCAL_WRITE_TOKEN_HEADER]).toBeUndefined();

    fetchFn.mockImplementation(async () => jsonResponse({ model }));
    // 档位两字段随创建一次落库（spec 37 创建写入路径）：请求体可选携带，此处显式携带验证透传；
    // protocol_adapter_id 必填（协议归属模型级），随创建体透传
    await api.createCustomChatModel({
      model_id: 'my-llm',
      connection_id: 'up_conn_test1',
      protocol_adapter_id: 'openai-chat-completions-v1',
      context_window_tokens: 300000,
      max_output_tokens: 8192,
      enabled_thinking_tiers: ['low'],
      default_thinking_tier: null,
    });
    const [createUrl, createInit] = fetchFn.mock.calls[1] as [string, RequestInit | undefined];
    expect(createUrl).toBe(`${BASE}/api/custom-chat-models`);
    expect(createInit?.method).toBe('POST');
    expect(createInit?.body).toBe(
      JSON.stringify({
        model_id: 'my-llm',
        connection_id: 'up_conn_test1',
        protocol_adapter_id: 'openai-chat-completions-v1',
        context_window_tokens: 300000,
        max_output_tokens: 8192,
        enabled_thinking_tiers: ['low'],
        default_thinking_tier: null,
      }),
    );
    expect((createInit?.headers as Record<string, string> | undefined)?.[HUB_LOCAL_WRITE_TOKEN_HEADER]).toBe(WRITE_TOKEN);

    // 修改是四字段整体替换：清空输出上限要显式传 null，清空档位要显式传空数组，不能靠漏字段表达。
    await api.updateCustomChatModel('my-llm', {
      context_window_tokens: 64000,
      max_output_tokens: null,
      enabled_thinking_tiers: [],
      default_thinking_tier: null,
    });
    const [updateUrl, updateInit] = fetchFn.mock.calls[2] as [string, RequestInit | undefined];
    expect(updateUrl).toBe(`${BASE}/api/custom-chat-models/my-llm`);
    expect(updateInit?.method).toBe('PUT');
    expect(updateInit?.body).toBe(
      JSON.stringify({
        context_window_tokens: 64000,
        max_output_tokens: null,
        enabled_thinking_tiers: [],
        default_thinking_tier: null,
      }),
    );

    // 删除响应只剩 model_id：active 接入由后端级联清理，不再回传接入计数
    fetchFn.mockImplementation(async () => jsonResponse({ model_id: 'my-llm' }));
    const removal = await api.deleteCustomChatModel('my-llm');
    expect(removal.model_id).toBe('my-llm');
    const [deleteUrl, deleteInit] = fetchFn.mock.calls[3] as [string, RequestInit | undefined];
    expect(deleteUrl).toBe(`${BASE}/api/custom-chat-models/my-llm`);
    expect(deleteInit?.method).toBe('DELETE');
  });

  it('自建对话模型：响应缺字段时 parse 失败（契约边界不放行）', async () => {
    // 缺少 record_id / connection_id / context_window_tokens / created_at —— 不得静默补默认值放行
    const fetchFn = fetchMock(async () => jsonResponse({ models: [{ model_id: 'my-llm' }] }));

    const api = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
    await expect(api.listCustomChatModels(undefined)).rejects.toThrow();

    fetchFn.mockImplementation(async () => jsonResponse({ model_id: 'my-llm' }));
    await api.deleteCustomChatModel('my-llm');
    const [url] = fetchFn.mock.calls[1] as [string, RequestInit | undefined];
    expect(url).toBe(`${BASE}/api/custom-chat-models/my-llm`);
  });
});
