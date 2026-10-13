import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

import type {
  CustomGenerationModel,
  ModelDeployment,
  ProviderConnection,
} from '@iart/contracts';
import { ProviderSection } from '../../ProviderSection';
import { createHubApiClient } from '../../../../client/api/hub-api';
import { createHubHttpClient } from '../../../../client/adapters/http-client';
import { countDeploymentsByConnection } from '../invalidity';
import type {
  ProviderConnectionData,
  ProviderNotice,
} from '../useProviderConnectionData';

/**
 * 生成族服务商「添加模型」的写入面（spec 03 §6.1「记录即接入」）。
 *
 * 与对话侧的先例（settings/__tests__/providerSectionModelConfig.test.tsx）同一套 Harness：
 * 数据源用真 api 客户端，只在最外层挡掉网络，断言**真正发出的请求体**——
 * 添加是否一次写入（能力属性 + 接入归属）、失败原因是否原样落在弹层里，
 * 取决于请求长什么样，而不是取决于界面渲染了什么。
 */

const WRITE_TOKEN = 'a'.repeat(32);
const BASE = 'http://localhost:4877';

const generationConnection: ProviderConnection = {
  connection_id: 'up_conn_gen1',
  display_name: '我的绘图服务',
  protocol_adapter_id: 'openai-image-v1',
  base_url: 'https://api.example.com',
  has_credential: true,
  lifecycle: 'enabled',
  revision: 1,
  created_at: '2026-09-24T00:00:00.000Z',
  updated_at: '2026-09-24T00:00:00.000Z',
};

/** 已装能力包模型在本服务商下的接入（自建记录不产生 Deployment，spec 03 §6.1） */
const existingDeployment: ModelDeployment = {
  deployment_id: 'up_dep_gen1',
  model_id: 'gpt-image-1',
  connection_id: generationConnection.connection_id,
  remote_model_id: 'gpt-image-1',
  created_at: '2026-09-24T00:00:00.000Z',
  updated_at: '2026-09-24T00:00:00.000Z',
};

/** 被 mock 的数据源；用例的 Harness 每次渲染把它刷成当前值。 */
const stateRef = vi.hoisted(() => ({ current: null as ProviderConnectionData | null }));

vi.mock('../ProviderDataContext', () => ({
  useProviderData: (): ProviderConnectionData => {
    if (stateRef.current === null) throw new Error('用例没有装载数据源');
    return stateRef.current;
  },
}));

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * 族模板参数描述（GET /api/generation-family-templates/openai-image-v1 的响应）：
 * 与真实形状同形（contracts 的 FamilyTemplateParameterDescriptorSchema 在客户端 parse 它，
 * 形状不对这里自己先红）。标签直接给中文——真实响应里 label 已由 backend 按 runtime.i18n 解析。
 */
const familyTemplateDescriptor = {
  family_adapter_id: 'openai-image-v1',
  official_fields: [
    {
      field_key: 'size',
      label: '画面尺寸',
      component: 'imageSize',
      wire_name: 'size',
      required: false,
      default_value: 'auto',
      enum_options: [],
      resolution_presets: [
        { key: '1k', label: '1K' },
        { key: '2k', label: '2K' },
      ],
      aspect_presets: [],
    },
    {
      field_key: 'quality',
      label: '图片画质',
      component: 'select',
      wire_name: 'quality',
      required: false,
      default_value: 'auto',
      enum_options: ['auto', 'low', 'medium', 'high'],
      resolution_presets: [],
      aspect_presets: [],
    },
    {
      field_key: 'format',
      label: '输出格式',
      component: 'select',
      wire_name: 'output_format',
      required: false,
      default_value: 'jpeg',
      enum_options: ['png', 'jpeg', 'webp'],
      resolution_presets: [],
      aspect_presets: [],
    },
    {
      field_key: 'moderation',
      label: '内容审核',
      component: 'select',
      wire_name: 'moderation',
      required: false,
      default_value: 'auto',
      enum_options: ['auto', 'low'],
      resolution_presets: [],
      aspect_presets: [],
    },
  ],
  reserved_wire_names: ['model', 'prompt', 'input', 'n'],
};

/**
 * 按路径给响应：`failCreate`（409 重名兜底）与 `failDeterministic`（400 确定性拒绝）分别保护
 * 「409 给前端自己的可读冲突提示」与「确定性拒绝的后端原因原样透出弹层」。
 *
 * 成功的响应与真实形状同形（contracts 的 CustomGenerationModelResponseSchema
 * 会在客户端 parse 它，形状不对这里自己先红）。
 */
const stubFetch = ({ failCreate = false, failDeterministic = false, failTemplate = false } = {}): FetchMock => {
  const mock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async (input, init) => {
      const url = String(input);
      if (url.includes('/api/generation-family-templates/')) {
        if (failTemplate) return jsonResponse({ message: 'boom' }, 500);
        return jsonResponse(familyTemplateDescriptor);
      }
      if (url.includes('/api/custom-generation-models') && init?.method === 'POST') {
        if (failCreate) {
          return jsonResponse({ message: '已经添加过这个模型了' }, 409);
        }
        if (failDeterministic) {
          // 确定性拒绝（写入侧校验，如命名空间护栏）：message 是后端写给用户读的可操作原因
          return jsonResponse({ message: '这个模型 ID 只能用于图像模型' }, 400);
        }
        const declared = JSON.parse(String(init.body)) as {
          model_id: string;
          connection_id: string;
          remote_model_id?: string;
          supports_reference_image?: boolean;
        };
        return jsonResponse({
          model: {
            model_id: declared.model_id,
            record_id: 'up_dep_rec_new1',
            connection_id: declared.connection_id,
            remote_model_id: declared.remote_model_id ?? declared.model_id,
            family_adapter_id: 'openai-image-v1',
            supports_reference_image: declared.supports_reference_image === true,
            parameter_overrides: { official: [], custom: [] },
            created_at: '2026-09-24T00:00:00.000Z',
          },
        });
      }
      if (url.includes('/api/custom-generation-models/') && init?.method === 'PUT') {
        const modelId = url.split('/api/custom-generation-models/')[1] ?? '';
        const body = JSON.parse(String(init.body)) as {
          supports_reference_image: boolean;
          parameter_overrides?: { official: unknown[]; custom: unknown[] };
        };
        return jsonResponse({
          model: {
            model_id: decodeURIComponent(modelId),
            record_id: 'up_dep_rec1',
            connection_id: generationConnection.connection_id,
            remote_model_id: decodeURIComponent(modelId),
            family_adapter_id: 'openai-image-v1',
            supports_reference_image: body.supports_reference_image,
            parameter_overrides: body.parameter_overrides ?? { official: [], custom: [] },
            created_at: '2026-09-24T00:00:00.000Z',
          },
        });
      }
      if (url.includes('/api/custom-generation-models/') && init?.method === 'DELETE') {
        const modelId = url.split('/api/custom-generation-models/')[1] ?? '';
        return jsonResponse({ model_id: decodeURIComponent(modelId) });
      }
      throw new Error(`未预期的请求：${init?.method ?? 'GET'} ${url}`);
    },
  );
  vi.stubGlobal('fetch', mock);
  return mock;
};

/** 数据源 + 提示条状态：提示是分区自己持有的状态，桩里也要能变，否则成功提示断言看不到东西。 */
function Harness({
  deployments = [],
  customGenerationModels = [],
}: {
  deployments?: ModelDeployment[];
  /** 自己添加的生成模型：模型行按记录渲染，删除入口只挂在记录行上 */
  customGenerationModels?: CustomGenerationModel[];
}) {
  const [notice, setNotice] = useState<ProviderNotice | null>(null);
  stateRef.current = {
    api: createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN)),
    connections: [generationConnection],
    deployments,
    activeRoutes: {},
    activeDeploymentIds: new Set(),
    connectionById: new Map([[generationConnection.connection_id, generationConnection]]),
    deploymentCountByConnection: countDeploymentsByConnection(deployments),
    catalog: [],
    chatCatalog: [],
    catalogUnavailable: false,
    chatCatalogUnavailable: false,
    thinkingTierPool: { builtin: [], custom: [] },
    thinkingTierPoolUnavailable: false,
    customChatModels: [],
    customChatModelsUnavailable: false,
    customGenerationModels,
    customGenerationModelsUnavailable: false,
    agentDefaultModelId: null,
    saveAgentDefaultModel: async () => undefined,
    generationDefaultModelId: null,
    saveGenerationDefaultModel: async () => undefined,
    loading: false,
    notice,
    setNotice,
    reload: async () => undefined,
  };
  return <ProviderSection />;
}

const openDetail = (
  overrides: Partial<ProviderConnectionData> = {},
): void => {
  render(<Harness {...overrides} />);
  fireEvent.click(screen.getByText('我的绘图服务'));
};

const dialog = () => within(screen.getByRole('dialog', { name: '添加模型到「我的绘图服务」' }));

const editDialog = () => within(screen.getByRole('dialog', { name: '修改「my-image-model」的模型配置' }));

/**
 * 「添加模型」恒先出二级选择（2026-09-29 起连接级预选摘除）：选「生成模型」开合并弹窗。
 * 下拉对键盘可见：键盘打开（Radix 菜单不响应 jsdom 里的裸 click）。
 */
const openAddModelDialog = (): void => {
  fireEvent.keyDown(screen.getByRole('button', { name: '添加模型' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('menuitem', { name: '生成模型' }));
};

/** 在弹窗里选「接口类型」（下拉渲染在 portal，选项按 body 级查询；jsdom 无 PointerEvent：键盘开下拉，click 选中）。 */
const chooseFamilyAdapter = (): void => {
  fireEvent.keyDown(dialog().getByLabelText('接口类型'), { key: 'Enter' });
  fireEvent.click(screen.getByRole('option', { name: 'OpenAI Image' }));
};

/** 与真实列表响应同形（contracts 的 CustomGenerationModelSchema 在客户端 parse 它） */
const declaredRecord: CustomGenerationModel = {
  model_id: 'my-image-model',
  record_id: 'up_dep_rec1',
  connection_id: generationConnection.connection_id,
  remote_model_id: 'my-image-model',
  family_adapter_id: 'openai-image-v1',
  supports_reference_image: true,
  parameter_overrides: { official: [], custom: [] },
  created_at: '2026-09-24T00:00:00.000Z',
};

const bodyOf = (mock: FetchMock, match: string, method: string): unknown => {
  const call = mock.mock.calls.find(([input, init]) => String(input).includes(match) && init?.method === method);
  if (call === undefined) throw new Error(`没有发出 ${method} ${match}`);
  return JSON.parse(String(call[1]?.body));
};

describe('生成族服务商：添加模型提交流', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('添加是一次写入：能力属性与接入归属同一次落库，成功后关弹层；不再串联接入与设为当前使用', async () => {
    const fetchFn = stubFetch();
    openDetail();

    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    chooseFamilyAdapter();
    fireEvent.change(dialog().getByLabelText('服务商那边的模型 ID'), { target: { value: 'remote-name' } });
    fireEvent.click(dialog().getByRole('checkbox', { name: '支持参考图' }));
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('已添加「my-image-model」')).toBeInTheDocument();
    });

    // 声明体显式携带族适配器（试点单族封闭），能力勾选与接入归属随记录落库
    expect(bodyOf(fetchFn, '/api/custom-generation-models', 'POST')).toEqual({
      model_id: 'my-image-model',
      connection_id: generationConnection.connection_id,
      remote_model_id: 'remote-name',
      family_adapter_id: 'openai-image-v1',
      supports_reference_image: true,
    });
    // active 接入由后端在创建内写入：不再有 createModelDeployment / setActiveRoute 跟进
    expect(fetchFn.mock.calls.some(([input]) => String(input).includes('/api/model-deployments'))).toBe(false);
    expect(fetchFn.mock.calls.some(([input]) => String(input).includes('/api/active-routes'))).toBe(false);
  });

  it('远端模型名留空：请求体不带 remote_model_id（契约缺省回落模型 ID），能力勾选照常携带', async () => {
    const fetchFn = stubFetch();
    openDetail();

    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    chooseFamilyAdapter();
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(bodyOf(fetchFn, '/api/custom-generation-models', 'POST')).toEqual({
        model_id: 'my-image-model',
        connection_id: generationConnection.connection_id,
        family_adapter_id: 'openai-image-v1',
        supports_reference_image: false,
      });
    });
  });

  it('重名撞上后端 409 兜底：给「换名字」的可读提示，弹层留着', async () => {
    stubFetch({ failCreate: true });
    openDetail();

    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    chooseFamilyAdapter();
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(dialog().getByRole('alert')).toHaveTextContent(
        '「my-image-model」这个名字已经有模型在用了，换一个模型 ID 再添加。',
      );
    });
    expect(screen.getByRole('dialog', { name: '添加模型到「我的绘图服务」' })).toBeInTheDocument();
  });

  it('后端确定性拒绝的原因原样透出弹层，弹层留着', async () => {
    stubFetch({ failDeterministic: true });
    openDetail();

    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    chooseFamilyAdapter();
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(dialog().getByRole('alert')).toHaveTextContent(
        '这个模型 ID 只能用于图像模型',
      );
    });
    expect(screen.getByRole('dialog', { name: '添加模型到「我的绘图服务」' })).toBeInTheDocument();
  });

  it('要添加的模型已经在这个服务商上：提交前说清，不发写入请求', async () => {
    const fetchFn = stubFetch();
    openDetail({ customGenerationModels: [declaredRecord] });

    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    chooseFamilyAdapter();
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    // 用户的目标已经达成，写入只会撞上重名：提交前说清并指到修改入口
    await waitFor(() => {
      expect(dialog().getByRole('alert')).toHaveTextContent(
        '「my-image-model」已经添加到这个服务商了。想改它，关掉这个窗口后在列表里点「修改」。',
      );
    });
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});

describe('生成族服务商：删除自建模型', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('自己添加的生成模型行有「删除模型」：确认说明模型会消失及其影响，确认后发 DELETE', async () => {
    const fetchFn = stubFetch();
    openDetail({ deployments: [existingDeployment], customGenerationModels: [declaredRecord] });

    fireEvent.click(screen.getByRole('button', { name: '删除模型「my-image-model」' }));

    // 影响面写在确认文案里：模型本身将消失（从模型列表与画布生成里），不再有接入计数
    const confirmDelete = () => within(screen.getByRole('dialog', { name: '删除模型' }));
    expect(
      confirmDelete().getByText('确定删除「my-image-model」吗？删除后它会从模型列表里消失，画布里也没法再用它生成。'),
    ).toBeInTheDocument();
    fireEvent.click(confirmDelete().getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(
        fetchFn.mock.calls.some(
          ([input, init]) =>
            String(input).includes('/api/custom-generation-models/my-image-model') && init?.method === 'DELETE',
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText('已删除模型「my-image-model」')).toBeInTheDocument();
    });
  });

  it('取消确认时不发删除请求', () => {
    const fetchFn = stubFetch();
    openDetail({ deployments: [existingDeployment], customGenerationModels: [declaredRecord] });

    fireEvent.click(screen.getByRole('button', { name: '删除模型「my-image-model」' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '删除模型' })).getByRole('button', { name: '取消' }));

    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('已装模型行（不在自建记录里）没有「删除模型」：没有记录可删，不提供必然失败的入口', () => {
    stubFetch();
    openDetail({ deployments: [existingDeployment] });

    expect(screen.queryByRole('button', { name: '删除模型「gpt-image-1」' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^移除 / })).toBeInTheDocument();
  });
});

describe('生成族服务商：添加时自定义参数（高级参数自定义）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const expandAdvanced = async (): Promise<void> => {
    fireEvent.click(dialog().getByRole('button', { name: '高级参数自定义' }));
    // 展开即拉取族模板参数描述：编辑器出现才算装载完成
    await waitFor(() => {
      expect(dialog().getByText('图片画质')).toBeInTheDocument();
    });
  };

  it('改别名 + 停用一个参数：提交体携带 parameter_overrides，没动的参数不产生条目', async () => {
    const fetchFn = stubFetch();
    openDetail();

    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    chooseFamilyAdapter();
    await expandAdvanced();

    // 别名：把「输出格式」的发送名称改成服务商自己的名字（失焦提交）
    const wireInput = dialog().getByLabelText('「输出格式」的发送名称');
    fireEvent.change(wireInput, { target: { value: 'image_format' } });
    fireEvent.blur(wireInput);
    // 停用：关掉「内容审核」的启用开关
    fireEvent.click(dialog().getByRole('switch', { name: '启用参数「内容审核」' }));

    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(bodyOf(fetchFn, '/api/custom-generation-models', 'POST')).toEqual({
        model_id: 'my-image-model',
        connection_id: generationConnection.connection_id,
        family_adapter_id: 'openai-image-v1',
        supports_reference_image: false,
        parameter_overrides: {
          official: [
            { field_key: 'format', wire_name: 'image_format' },
            { field_key: 'moderation', enabled: false },
          ],
          custom: [],
        },
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('发送名称撞保留键：提交被拦在弹层里，不发请求', async () => {
    const fetchFn = stubFetch();
    openDetail();

    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    chooseFamilyAdapter();
    await expandAdvanced();

    const wireInput = dialog().getByLabelText('「图片画质」的发送名称');
    fireEvent.change(wireInput, { target: { value: 'prompt' } });
    fireEvent.blur(wireInput);
    await waitFor(() => {
      expect(dialog().getByRole('alert')).toHaveTextContent('这个发送名称不能用了：可能和别的参数重名，或已被模型自带的内容占用。换一个。');
    });

    fireEvent.click(dialog().getByRole('button', { name: '添加' }));
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    // 行内提示与弹层级提示都在（两个 role=alert）：行内的说改什么，弹层级的说去哪改
    const alerts = dialog().getAllByRole('alert').map((element) => element.textContent ?? '');
    expect(alerts.join(' ')).toContain('这个发送名称不能用了');
    expect(alerts.join(' ')).toContain('高级参数还有没改好的地方');
  });

  it('读不到参数描述：高级区显示一行原因，基础添加照常（请求体不带 parameter_overrides）', async () => {
    const fetchFn = stubFetch({ failTemplate: true });
    openDetail();

    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    chooseFamilyAdapter();
    fireEvent.click(dialog().getByRole('button', { name: '高级参数自定义' }));

    await waitFor(() => {
      expect(dialog().getByText('暂时读不到可调的参数，这项设置用不了；收起再展开可以再试。其他设置不受影响。')).toBeInTheDocument();
    });

    fireEvent.click(dialog().getByRole('button', { name: '添加' }));
    await waitFor(() => {
      expect(bodyOf(fetchFn, '/api/custom-generation-models', 'POST')).toEqual({
        model_id: 'my-image-model',
        connection_id: generationConnection.connection_id,
        family_adapter_id: 'openai-image-v1',
        supports_reference_image: false,
      });
    });
  });
});

describe('生成族服务商：编辑已添加模型（参数覆盖 + 参考图开关）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 带现有覆盖的记录：与真实列表响应同形（contracts 在客户端 parse 它） */
  const declaredWithOverrides: CustomGenerationModel = {
    ...declaredRecord,
    parameter_overrides: {
      official: [{ field_key: 'format', wire_name: 'image_format' }],
      custom: [],
    },
  };

  it('自建记录行有「修改」：弹层回填现有覆盖，保存走 PUT 整体替换', async () => {
    const fetchFn = stubFetch();
    openDetail({ deployments: [existingDeployment], customGenerationModels: [declaredWithOverrides] });

    fireEvent.click(screen.getByRole('button', { name: '修改「my-image-model」的配置' }));

    // 展开高级区（默认收起），装载完成后再看回填
    fireEvent.click(editDialog().getByRole('button', { name: '高级参数自定义' }));
    await waitFor(() => {
      expect(editDialog().getByText('图片画质')).toBeInTheDocument();
    });

    // 现有覆盖回填进发送名称输入框
    const wireInput = editDialog().getByLabelText('「输出格式」的发送名称') as HTMLInputElement;
    expect(wireInput.value).toBe('image_format');

    fireEvent.change(wireInput, { target: { value: 'image_format2' } });
    fireEvent.blur(wireInput);
    fireEvent.click(editDialog().getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const put = fetchFn.mock.calls.find(
        ([input, init]) =>
          String(input).includes('/api/custom-generation-models/my-image-model') && init?.method === 'PUT',
      );
      expect(put).toBeDefined();
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({
        supports_reference_image: true,
        parameter_overrides: {
          official: [{ field_key: 'format', wire_name: 'image_format2' }],
          custom: [],
        },
      });
    });
    await waitFor(() => {
      expect(screen.getByText('已保存「my-image-model」的模型配置')).toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('已装模型行没有「修改」入口（参数表单在包定义里，不属于行内可改）', () => {
    stubFetch();
    openDetail({ deployments: [existingDeployment] });

    expect(screen.queryByRole('button', { name: '修改「gpt-image-1」的配置' })).not.toBeInTheDocument();
  });
});
