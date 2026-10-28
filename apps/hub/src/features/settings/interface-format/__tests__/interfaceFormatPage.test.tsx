import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  InterfaceFormatDetail,
  InterfaceFormatSummary,
  InterfaceRecipe,
} from '@iart/contracts';

import { InterfaceFormatPage } from '../InterfaceFormatPage';
import { createHubApiClient } from '../../../../client/api/hub-api';
import { createHubHttpClient } from '../../../../client/adapters/http-client';
import type { HubApiClient } from '../../../../client/types';

/**
 * 「接口格式」页（docs/custom-providers/接口格式旅程-design.md §1.2、§4；
 * docs/hub/hub-information-architecture.md §7.9）。
 *
 * 数据源用真 api 客户端、只在最外层挡掉网络：断言的是真正发出的请求体与契约 parse 后的
 * 渲染结果，不是组件的内部状态。详情按 format_id 打桩——列表装载会为每行取一次详情
 * （同步 / 异步标记来自详情契约，摘要不承载该事实）。
 */

const WRITE_TOKEN = 'a'.repeat(32);
const BASE = 'http://localhost:4877';

const summaryOf = (
  formatId: string,
  displayName: string,
  order: number,
): InterfaceFormatSummary => ({
  format_id: formatId,
  display_name: displayName,
  family: 'generation',
  status: 'ready',
  supports_media_slots: ['reference_image'],
  required_media_slots: [],
  order,
  origin: 'preset',
  version: '1.0.0',
});

const summaries: InterfaceFormatSummary[] = [
  summaryOf('openai-image-v1', 'OpenAI Image', 10),
  summaryOf('openai-video-v1', 'OpenAI 视频', 20),
  summaryOf('gemini-image-interactions-v1', 'Gemini Image', 30),
  summaryOf('seedance-2-0-v1', 'Seedance 2.0', 40),
  summaryOf('veo-v1', 'Veo', 50),
  summaryOf('kling-text2video-v1', 'Kling 文生视频', 60),
  summaryOf('kling-image2video-v1', 'Kling 图生视频', 70),
  summaryOf('kling-omni-video-v1', 'Kling 全模态视频', 80),
];

/** 同步格式详情（提交 + 参数 + 内置判定，无轮询段）。 */
const syncDetail = (summary: InterfaceFormatSummary): InterfaceFormatDetail => ({
  summary,
  transport: {
    auth: { kind: 'bearer', header_name: 'Authorization', prefix: 'Bearer' },
    endpoints: {
      submit: '/v1/images/generations',
      edit: '/v1/images/edits',
    },
    submit: {
      method: 'POST',
      path: '/v1/images/generations',
      content_type: 'application/json',
      payload_format: 'json',
      headers: [],
      query: [],
      form_field_style: 'dotted',
      form_array_style: 'repeat',
    },
    async: null,
    prompt_binding: { location: 'body', path: 'prompt' },
    model_binding: { location: 'body', path: 'model' },
  },
  recipe_id: null,
  media_slots: [{ slot_id: 'reference_image', field_key: 'image', required: false, max_files: 4, carrier: 'multipart_file' }],
  parameter_descriptor: {
    family_adapter_id: summary.format_id,
    official_fields: [
      {
        field_key: 'size',
        label: '尺寸',
        component: 'select',
        wire_name: 'size',
        wire_location: 'body',
        required: true,
        default_value: '1024x1024',
        enum_options: ['1024x1024', '512x512'],
        resolution_presets: [],
        aspect_presets: [],
      },
    ],
    reserved_wire_names: { body: ['model', 'prompt', 'input'], query: [], header: [] },
    supports_media_slots: ['reference_image'],
    required_media_slots: [],
  },
  builtin_behavior: {
    has_success_condition: true,
    result_form: 'direct_url',
    requires_auth: false,
    failure_reason_present: true,
  },
  used_by_model_count: 2,
});

/** 异步格式详情：带任务标识路径与轮询规则。 */
const asyncDetail = (summary: InterfaceFormatSummary): InterfaceFormatDetail => ({
  ...syncDetail(summary),
  transport: {
    auth: { kind: 'header_api_key', header_name: 'x-api-key' },
    endpoints: { submit: '/v1/videos', task: '/v1/videos/{id}' },
    submit: {
      method: 'POST',
      path: '/v1/videos',
      content_type: 'application/json',
      payload_format: 'json',
      headers: [{ name: 'X-Client', value: 'test' }],
      query: [],
      form_field_style: 'dotted',
      form_array_style: 'repeat',
    },
    async: {
      identity_path: 'id',
      polling: {
        url_template: '/v1/videos/{id}',
        method: 'GET',
        interval_ms: 2000,
        max_attempts: 60,
        headers: [],
        query: [{ name: 'task', value: '{id}' }],
        body_format: 'json',
        content_type: null,
      },
    },
    prompt_binding: { location: 'query', name: 'prompt' },
    model_binding: { location: 'path' },
  },
  builtin_behavior: {
    has_success_condition: true,
    result_form: 'needs_fetch',
    requires_auth: true,
    failure_reason_present: false,
  },
  used_by_model_count: 5,
});

const detailFor = (formatId: string): InterfaceFormatDetail => {
  const summary = summaries.find((item) => item.format_id === formatId);
  if (summary === undefined) throw new Error(`没有这个格式：${formatId}`);
  return formatId === 'openai-video-v1' ? asyncDetail(summary) : syncDetail(summary);
};

const recipe: InterfaceRecipe = {
  recipe_id: 'recipe-1',
  name: 'OpenAI 完成判定',
  family_adapter_id: 'openai-image-v1',
  success_when: { op: 'eq', path: 'status', value: 'succeeded' },
  result: { kind: 'direct_url', media_field_paths: ['data.url'], media_type: 'image' },
  requires_auth: false,
  created_at: '2026-10-24T00:00:00.000Z',
  updated_at: '2026-10-24T01:00:00.000Z',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** api 与配方标签的数据源都经 useHubRuntime 取；桩里只放用例需要的字段。 */
const apiRef = vi.hoisted(() => ({ current: null as HubApiClient | null }));
vi.mock('../../../../components/providers/HubAppProvider', () => ({
  useHubRuntime: (): { api: HubApiClient } => {
    if (apiRef.current === null) throw new Error('用例没有装载 api');
    return { api: apiRef.current };
  },
}));

/**
 * 第二标签的数据来自 ProviderDataProvider；这里只替换数据源（配方区块本身用真实实现），
 * 避免在格式页用例里再装载整套服务商数据。
 */
const recipeStateRef = vi.hoisted(() => ({
  current: null as {
    api: HubApiClient;
    interfaceRecipes: InterfaceRecipe[];
    interfaceRecipesUnavailable: boolean;
    notice: { tone: 'success' | 'warn' | 'error'; text: string } | null;
    setNotice: (notice: null) => void;
    reload: () => Promise<void>;
  } | null,
}));
vi.mock('../../provider-connection/ProviderDataContext', () => ({
  ProviderDataProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useProviderData: () => {
    if (recipeStateRef.current === null) throw new Error('用例没有装载配方数据源');
    return recipeStateRef.current;
  },
}));

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

const copySummary: InterfaceFormatSummary = {
  format_id: 'if_copy',
  display_name: 'OpenAI Image 副本',
  family: 'generation',
  status: 'ready',
  supports_media_slots: ['reference_image'],
  required_media_slots: [],
  order: 110,
  origin: 'user',
  version: '1.0.0',
};

/** 复制响应里的详情：与源格式同形，身份换成新格式（服务端整实体克隆）。 */
const copyDetail = (recipeId: string | null): InterfaceFormatDetail => ({
  ...syncDetail(copySummary),
  recipe_id: recipeId,
});

const stubFetch = (
  {
    formats = summaries,
    empty = false,
    failList = false,
    copyRecipeId = 'ir_copy',
  }: {
    formats?: InterfaceFormatSummary[];
    empty?: boolean;
    failList?: boolean;
    /** 复制后的判定：`null` = 服务端没有可靠派生出判定与结果形态。 */
    copyRecipeId?: string | null;
  } = {},
): FetchMock => {
  /** 复制后列表要多出这一条：复制流程会 reload 并选中它。 */
  let copied: InterfaceFormatSummary | null = null;
  const mock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/api/interface-formats/') && url.pathname.endsWith('/copy')) {
        const formatId = decodeURIComponent(url.pathname.split('/')[3] ?? '');
        if (formatId === 'openai-image-v1') {
          copied = copySummary;
          return jsonResponse({
            format_id: copySummary.format_id,
            recipe_id: copyRecipeId,
            detail: copyDetail(copyRecipeId),
          });
        }
        return jsonResponse({ error: { code: 'not_found', message: '没有这个格式' } }, 404);
      }
      if (url.pathname === '/api/interface-formats' && init?.method === 'POST') {
        const createdSummary: InterfaceFormatSummary = {
          format_id: 'if_new',
          display_name: '我的格式',
          family: 'generation',
          status: 'ready',
          supports_media_slots: ['reference_image'],
          required_media_slots: [],
          order: 100,
          origin: 'user',
          version: '1.0.0',
        };
        return jsonResponse({
          format_id: 'if_new',
          recipe_id: 'ir_new',
          detail: { ...syncDetail(createdSummary), recipe_id: 'ir_new' },
        });
      }
      if (url.pathname === '/api/interface-formats') {
        if (failList) return jsonResponse({ error: { code: 'internal', message: '拒绝' } }, 500);
        if (empty) return jsonResponse({ formats: [] });
        return jsonResponse({ formats: copied === null ? formats : [...formats, copied] });
      }
      if (url.pathname.startsWith('/api/interface-formats/') && url.pathname.endsWith('/path-discovery')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { sample: unknown };
        return jsonResponse({
          paths: [
            { path: 'data.url', value: (body.sample as { data?: { url?: string } }).data?.url ?? null, value_kind: 'string' },
            { path: 'id', value: 'task-1', value_kind: 'string' },
          ],
        });
      }
      if (url.pathname.startsWith('/api/interface-formats/')) {
        const formatId = decodeURIComponent(url.pathname.split('/')[3] ?? '');
        if (formatId === copySummary.format_id) return jsonResponse(copyDetail(copyRecipeId));
        return jsonResponse(detailFor(formatId));
      }
      throw new Error(`未预期的请求：${init?.method ?? 'GET'} ${url.pathname}`);
    },
  );
  vi.stubGlobal('fetch', mock);
  return mock;
};

const renderPage = (onSelectSection: (id: string) => void = () => undefined) => {
  apiRef.current = createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN));
  recipeStateRef.current = {
    api: apiRef.current,
    interfaceRecipes: [recipe],
    interfaceRecipesUnavailable: false,
    notice: null,
    setNotice: () => undefined,
    reload: async () => undefined,
  };
  render(<InterfaceFormatPage onSelectSection={onSelectSection} />);
};

const rail = (): HTMLElement => screen.getByRole('group', { name: '接口格式列表' });

const openPanel = (): void => {
  fireEvent.click(screen.getByRole('button', { name: '样本面板' }));
};

/** 等列表装载完成后打开「新建格式」编辑器。 */
const openNewFormatEditor = async (): Promise<void> => {
  await waitFor(() => {
    expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
  });
  fireEvent.click(screen.getByRole('button', { name: '新建格式' }));
};

/** 填完异步模式的必填项；成功值 / 失败值留给用例自己填，便于断言空值分支。 */
const fillAsyncRequiredFields = (): void => {
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的异步格式' } });
  fireEvent.change(screen.getByLabelText('提交路径'), { target: { value: '/v1/tasks' } });
  fireEvent.change(screen.getByLabelText('产物路径（每行一个）'), { target: { value: 'data.url' } });
  fireEvent.keyDown(screen.getByRole('combobox', { name: '任务模式' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: '先返回任务，稍后再取' }));
  fireEvent.change(screen.getByLabelText('任务标识位置'), { target: { value: 'id' } });
  fireEvent.change(screen.getByLabelText('轮询地址'), { target: { value: '/v1/tasks/{id}' } });
  fireEvent.change(screen.getByLabelText('状态字段'), { target: { value: 'status' } });
};

beforeEach(() => {
  // jsdom 不实现滚动；点保存定位第一个错误时会调用它
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('接口格式：列表与定义', () => {
  it('列表渲染 8 条，默认选中第一条，详情显示提交 / 参数 / 被使用次数', async () => {
    renderPage();

    await waitFor(() => {
      expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
    });
    expect(within(rail()).getByText('OpenAI Image')).toBeInTheDocument();
    // 同步标记来自详情装载（摘要不承载传输形态）
    await waitFor(() => {
      expect(within(rail()).getAllByText('同步')).toHaveLength(7);
    });

    const firstRow = rail().querySelector('[data-format-row]');
    expect(firstRow).toHaveAttribute('aria-pressed', 'true');

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'OpenAI Image' })).toBeInTheDocument();
    });
    expect(screen.getByText('POST /v1/images/generations')).toBeInTheDocument();
    expect(screen.getByText('尺寸')).toBeInTheDocument();
    expect(screen.getByText('被 2 个模型使用')).toBeInTheDocument();
    expect(screen.getByText('判定与结果由接口配方承载。')).toBeInTheDocument();
  });

  it('切换选中后详情更新：异步格式显示任务标识与轮询', async () => {
    renderPage();
    await waitFor(() => {
      expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
    });

    fireEvent.click(within(rail()).getByText('OpenAI 视频'));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'OpenAI 视频' })).toBeInTheDocument();
    });
    expect(screen.getByText('轮询')).toBeInTheDocument();
    expect(screen.getByText('GET /v1/videos/{id}')).toBeInTheDocument();
    expect(screen.getByText('每 2 秒查一次，最多 60 次')).toBeInTheDocument();
    expect(screen.getByText('被 5 个模型使用')).toBeInTheDocument();
    expect(within(rail()).getByText('异步')).toBeInTheDocument();
  });

  it('搜索过滤列表；无匹配时说明没有匹配的格式', async () => {
    renderPage();
    await waitFor(() => {
      expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
    });

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索接口格式' }), {
      target: { value: 'kling' },
    });
    expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(3);

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索接口格式' }), {
      target: { value: '不存在的格式' },
    });
    expect(within(rail()).getByText('没有匹配的接口格式。')).toBeInTheDocument();
  });
});

describe('接口格式：新建同步格式', () => {
  it('填完必填项后提交声明式草稿，后端合成实体与配方', async () => {
    const fetchMock = stubFetch();
    renderPage();
    await waitFor(() => {
      expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
    });

    fireEvent.click(screen.getByRole('button', { name: '新建格式' }));
    expect(screen.getByRole('heading', { name: '新建接口格式' })).toBeInTheDocument();

    // 初始缺口清单会点出必填项；提示词位置默认已有值，不需要改。
    expect(screen.getByText(/还差 \d+ 项/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的格式' } });
    fireEvent.change(screen.getByLabelText('提交路径'), { target: { value: '/v1/mine' } });
    fireEvent.change(screen.getByLabelText('产物路径（每行一个）'), { target: { value: 'data.0.url' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) => String(input).endsWith('/api/interface-formats') && init?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body)) as {
        display_name: string;
        submit: { path: string; method: string; payload_format: string };
        prompt_binding: unknown;
        behavior: { result: unknown };
      };
      expect(body.display_name).toBe('我的格式');
      expect(body.submit.path).toBe('/v1/mine');
      expect(body.submit.method).toBe('POST');
      expect(body.submit.payload_format).toBe('json');
      expect(body.prompt_binding).toEqual({ location: 'body', path: 'prompt' });
      expect(body.behavior.result).toEqual({
        kind: 'direct_url',
        media_field_paths: ['data.0.url'],
        media_type: 'image',
      });
    });
  });

  it('必填项没填时点保存不提交，汇总点名并聚焦第一个缺口', async () => {
    const fetchMock = stubFetch();
    renderPage();
    await waitFor(() => {
      expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
    });

    fireEvent.click(screen.getByRole('button', { name: '新建格式' }));
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
    expect(screen.getByText(/还差 \d+ 项/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '名称' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交路径' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '产物路径' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('名称'));
    expect(screen.getByLabelText('名称')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('名称要填')).toBeInTheDocument();
  });
  it('异步模式：标识 / 轮询 / 状态 / 成功值进草稿', async () => {
    const fetchMock = stubFetch();
    renderPage();
    await waitFor(() => {
      expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
    });

    fireEvent.click(screen.getByRole('button', { name: '新建格式' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的异步格式' } });
    fireEvent.change(screen.getByLabelText('提交路径'), { target: { value: '/v1/tasks' } });
    fireEvent.change(screen.getByLabelText('产物路径（每行一个）'), { target: { value: 'data.url' } });

    fireEvent.keyDown(screen.getByRole('combobox', { name: '任务模式' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: '先返回任务，稍后再取' }));

    fireEvent.change(screen.getByLabelText('任务标识位置'), { target: { value: 'id' } });
    fireEvent.change(screen.getByLabelText('轮询地址'), { target: { value: '/v1/tasks/{id}' } });
    fireEvent.change(screen.getByLabelText('状态字段'), { target: { value: 'status' } });
    fireEvent.change(screen.getByLabelText('成功值'), { target: { value: 'succeeded' } });
    fireEvent.click(screen.getByRole('button', { name: '为成功值添加取值' }));
    fireEvent.change(screen.getByLabelText('失败值（可留空）'), { target: { value: 'failed' } });
    fireEvent.click(screen.getByRole('button', { name: '为失败值添加取值' }));

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) => String(input).endsWith('/api/interface-formats') && init?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body)) as {
        behavior: {
          async?: {
            identity_path: string;
            polling: { path: string; status_path: string; success_values: string[]; failure_values: string[] };
          };
        };
      };
      expect(body.behavior.async).toEqual({
        identity_path: 'id',
        polling: {
          path: '/v1/tasks/{id}',
          method: 'GET',
          headers: [],
          query: [],
          body_format: 'json',
          content_type: null,
          status_path: 'status',
          success_values: ['succeeded'],
          failure_values: ['failed'],
          interval_ms: 10000,
          max_attempts: 300,
        },
      });
    });
  });
  it('成功值用值列表增删；一个都没有时点保存不提交，错误定位到成功值', async () => {
    const fetchMock = stubFetch();
    renderPage();
    await openNewFormatEditor();
    fillAsyncRequiredFields();

    fireEvent.change(screen.getByLabelText('成功值'), { target: { value: 'succeeded' } });
    fireEvent.click(screen.getByRole('button', { name: '为成功值添加取值' }));
    expect(screen.getByText('succeeded')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删掉成功值「succeeded」' }));
    expect(screen.queryByText('succeeded')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(screen.getByText('成功值至少要有一个')).toBeInTheDocument();
    expect(screen.getByLabelText('成功值')).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(screen.getByLabelText('成功值'));
  });
  it('失败值可留空：只填成功值时保存，草稿里失败值为空数组', async () => {
    const fetchMock = stubFetch();
    renderPage();
    await openNewFormatEditor();
    fillAsyncRequiredFields();

    fireEvent.change(screen.getByLabelText('成功值'), { target: { value: 'succeeded' } });
    fireEvent.click(screen.getByRole('button', { name: '为成功值添加取值' }));

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) => String(input).endsWith('/api/interface-formats') && init?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body)) as {
        behavior: { async?: { polling: { success_values: string[]; failure_values: string[] } } };
      };
      expect(body.behavior.async?.polling.success_values).toEqual(['succeeded']);
      expect(body.behavior.async?.polling.failure_values).toEqual([]);
    });
  });
  it('素材位：添加一行后写进草稿', async () => {
    const fetchMock = stubFetch();
    renderPage();
    await waitFor(() => {
      expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
    });

    fireEvent.click(screen.getByRole('button', { name: '新建格式' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的参考图格式' } });
    fireEvent.change(screen.getByLabelText('提交路径'), { target: { value: '/v1/edit' } });
    fireEvent.change(screen.getByLabelText('产物路径（每行一个）'), { target: { value: 'data.0.url' } });

    fireEvent.click(screen.getByRole('button', { name: '添加素材位' }));
    fireEvent.change(screen.getByLabelText(/素材位字段位置/), { target: { value: 'image' } });
    fireEvent.change(screen.getByLabelText(/素材位名称/), { target: { value: '参考图' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) => String(input).endsWith('/api/interface-formats') && init?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body)) as {
        media_slots: Array<{
          slot_id: string;
          field_key: string;
          label: string;
          required: boolean;
          max_files: number;
          carrier: string;
        }>;
      };
      expect(body.media_slots).toEqual([
        {
          slot_id: 'reference_image',
          field_key: 'image',
          label: '参考图',
          required: false,
          max_files: 1,
          carrier: 'public_url',
        },
      ]);
    });
  });
});

describe('接口格式：编辑器分节导航', () => {
  it('点分节后只有该节标为当前（aria-current），并滚动到对应分节', async () => {
    renderPage();
    await openNewFormatEditor();

    fireEvent.click(screen.getByRole('button', { name: '参数' }));

    expect(screen.getByRole('button', { name: '参数' })).toHaveAttribute('aria-current', 'location');
    expect(screen.getByRole('button', { name: '基本信息' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: '判定与结果' })).not.toHaveAttribute('aria-current');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '判定与结果' }));

    expect(screen.getByRole('button', { name: '判定与结果' })).toHaveAttribute('aria-current', 'location');
    expect(screen.getByRole('button', { name: '参数' })).not.toHaveAttribute('aria-current');
  });
});

describe('接口格式：标签与迁移后的配方', () => {
  it('切到「判定配方」渲染配方区块（配方从服务商页迁入）', async () => {
    renderPage();
    await waitFor(() => {
      expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
    });

    fireEvent.click(screen.getByRole('tab', { name: '判定配方' }));

    expect(screen.getByText('接口配方')).toBeInTheDocument();
    expect(screen.getByText('OpenAI 完成判定')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建配方' })).toBeInTheDocument();
  });
});

describe('接口格式：验证面板', () => {
  it('粘贴样本 → 请求体正确 → 列出路径 → 点击复制到剪贴板', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const fetchMock = stubFetch();
    renderPage();
    await waitFor(() => {
      expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
    });

    openPanel();
    fireEvent.change(screen.getByLabelText('响应样本'), {
      target: { value: '{"data":{"url":"https://example.com/a.png"}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '解析字段路径' }));

    await waitFor(() => {
      expect(screen.getByText('data.url')).toBeInTheDocument();
    });
    const discoveryCall = fetchMock.mock.calls.find(
      ([input]) => String(input).endsWith('/path-discovery'),
    );
    expect(discoveryCall).toBeDefined();
    expect(JSON.parse(String(discoveryCall?.[1]?.body))).toEqual({
      sample: { data: { url: 'https://example.com/a.png' } },
    });
    expect(screen.getByText('找到 2 个字段路径，点一个复制。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '复制路径 data.url' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('data.url');
    });
    expect(screen.getByRole('status')).toHaveTextContent('已复制');
  });

  it('样本不是 JSON 时给出可改的提示，不发请求', async () => {
    const fetchMock = stubFetch();
    renderPage();
    await waitFor(() => {
      expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
    });

    openPanel();
    fireEvent.change(screen.getByLabelText('响应样本'), { target: { value: '不是 JSON' } });
    fireEvent.click(screen.getByRole('button', { name: '解析字段路径' }));

    expect(screen.getByRole('alert')).toHaveTextContent('这段内容不是有效的 JSON，检查后再试。');
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/path-discovery'))).toBe(false);
  });
});

describe('接口格式：加载失败与空态', () => {
  it('列表读取失败说「没能读取接口格式」，不冒充空列表', async () => {
    stubFetch({ failList: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('没能读取接口格式')).toBeInTheDocument();
    });
    expect(screen.queryByRole('group', { name: '接口格式列表' })).not.toBeInTheDocument();
  });

  it('列表为空时给出空态与刷新入口', async () => {
    stubFetch({ empty: true });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('还没有可用的接口格式')).toBeInTheDocument();
    });
  });
});


describe('接口格式：复制为我的格式', () => {
  it('走后端整实体克隆，成功后选中新格式（客户端不拼装复制体）', async () => {
    const fetchMock = stubFetch({ copyRecipeId: 'ir_copy' });
    renderPage();
    await waitFor(() => {
      expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
    });

    fireEvent.click(screen.getByRole('button', { name: '复制为我的格式' }));

    await waitFor(() => {
      expect(screen.getByText('已复制为「OpenAI Image 副本」')).toBeInTheDocument();
    });
    const copyCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith('/copy') && init?.method === 'POST',
    );
    expect(copyCall).toBeDefined();
    // 不再用「新建格式」的 POST 草稿接口拼一份复制体
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input).endsWith('/api/interface-formats') && init?.method === 'POST',
      ),
    ).toBe(false);

    await waitFor(() => {
      expect(within(rail()).getByText('OpenAI Image 副本')).toBeInTheDocument();
    });
    const copiedRow = within(rail()).getByText('OpenAI Image 副本').closest('[data-format-row]');
    expect(copiedRow).toHaveAttribute('aria-pressed', 'true');
  });

  it('复制后没有可靠判定时打开编辑器并提示补全判定与结果', async () => {
    stubFetch({ copyRecipeId: null });
    renderPage();
    await waitFor(() => {
      expect(rail().querySelectorAll('[data-format-row]')).toHaveLength(8);
    });

    fireEvent.click(screen.getByRole('button', { name: '复制为我的格式' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '编辑接口格式' })).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toHaveTextContent('已复制传输设置，请补全判定与结果');
  });
});
