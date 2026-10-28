import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

import type {
  CustomGenerationModel,
  ProviderConnection,
} from '@iart/contracts';
import { PRESET_FORMAT_SUMMARIES } from './formatOptionsFixture';
import { ProviderSection } from '../../ProviderSection';
import { createHubApiClient } from '../../../../client/api/hub-api';
import { createHubHttpClient } from '../../../../client/adapters/http-client';
import { countModelsByConnection } from '../invalidity';
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
    // 素材位行（2026-10-24 起官方参数区也渲染它）：只有发送名称与最多几张两个维度
    {
      field_key: 'referenceImage',
      label: '参考图',
      component: 'imageUpload',
      wire_name: 'reference_image',
      wire_location: 'body',
      required: false,
      default_value: null,
      enum_options: [],
      resolution_presets: [],
      aspect_presets: [],
      media_slot_id: 'reference_image',
      media_max_files: 16,
    },
    {
      field_key: 'size',
      label: '画面尺寸',
      component: 'imageSize',
      wire_name: 'size',
      wire_location: 'body',
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
      wire_location: 'body',
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
      wire_location: 'body',
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
      wire_location: 'body',
      required: false,
      default_value: 'auto',
      enum_options: ['auto', 'low'],
      resolution_presets: [],
      aspect_presets: [],
    },
  ],
  reserved_wire_names: { body: ['model', 'prompt', 'input', 'n'], query: [], header: [] },
  // 2026-10-19 起表单按该族能力逐项渲染素材位勾选（openai 族只有参考图一位）
  supports_media_slots: ['reference_image'],
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
          // 确定性拒绝（写入侧校验，如素材位超出该族能力）：message 是后端写给用户读的可操作原因
          return jsonResponse({ message: '这个接口格式不接受「参考图」这类素材' }, 400);
        }
        const declared = JSON.parse(String(init.body)) as {
          model_id: string;
          connection_id: string;
          remote_model_id?: string;
          accepted_media_slots?: unknown;
        };
        return jsonResponse({
          model: {
            model_id: declared.model_id,
            record_id: 'up_dep_rec_new1',
            connection_id: declared.connection_id,
            remote_model_id: declared.remote_model_id ?? declared.model_id,
            family_adapter_id: 'openai-image-v1',
            accepted_media_slots: Array.isArray(declared.accepted_media_slots) ? declared.accepted_media_slots : [],
            parameter_overrides: { official: [], custom: [] },
            created_at: '2026-09-24T00:00:00.000Z',
          },
        });
      }
      if (url.includes('/api/custom-generation-models/') && init?.method === 'PUT') {
        const modelId = url.split('/api/custom-generation-models/')[1] ?? '';
        const body = JSON.parse(String(init.body)) as {
          accepted_media_slots: unknown[];
          parameter_overrides?: { official: unknown[]; custom: unknown[] };
        };
        return jsonResponse({
          model: {
            model_id: decodeURIComponent(modelId),
            record_id: 'up_dep_rec1',
            connection_id: generationConnection.connection_id,
            remote_model_id: decodeURIComponent(modelId),
            family_adapter_id: 'openai-image-v1',
            accepted_media_slots: body.accepted_media_slots,
            parameter_overrides: body.parameter_overrides ?? { official: [], custom: [] },
            created_at: '2026-09-24T00:00:00.000Z',
          },
        });
      }
      if (url.includes('/api/custom-generation-models/') && init?.method === 'DELETE') {
        const modelId = url.split('/api/custom-generation-models/')[1] ?? '';
        return jsonResponse({ model_id: decodeURIComponent(modelId) });
      }
      if (url.includes('/api/interface-formats')) {
        return jsonResponse({ formats: PRESET_FORMAT_SUMMARIES });
      }
      throw new Error(`未预期的请求：${init?.method ?? 'GET'} ${url}`);
    },
  );
  vi.stubGlobal('fetch', mock);
  return mock;
};

/** 数据源 + 提示条状态：提示是分区自己持有的状态，桩里也要能变，否则成功提示断言看不到东西。 */
function Harness({
  customGenerationModels = [],
}: {
  /** 自己添加的生成模型：模型行按记录渲染，删除入口只挂在记录行上 */
  customGenerationModels?: CustomGenerationModel[];
}) {
  const [notice, setNotice] = useState<ProviderNotice | null>(null);
  stateRef.current = {
    api: createHubApiClient(createHubHttpClient(BASE, WRITE_TOKEN)),
    connections: [generationConnection],
    activeRoutes: {},
    activeRecordIds: new Set(),
    connectionById: new Map([[generationConnection.connection_id, generationConnection]]),
    modelCountByConnection: countModelsByConnection(customGenerationModels),
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
    interfaceRecipes: [],
    interfaceRecipesUnavailable: false,
    agentDefaultModelId: null,
    saveAgentDefaultModel: async () => undefined,
    generationDefaultModelId: null,
    saveGenerationDefaultModel: async () => undefined,
    loadState: 'ready',
    loadError: null,
    notice,
    setNotice,
    reload: async () => undefined,
  };
  return <ProviderSection />;
}

/** 在左侧服务商栏里点选某一家（详情头也会显示同一名字，故定位收窄到栏内） */
const selectProviderInRail = (name: string): void => {
  const rail = screen.getByRole('group', { name: '服务商列表' });
  const card = within(rail)
    .queryAllByRole('button')
    .find((el) => (el.textContent ?? '').includes(name));
  if (!card) throw new Error(`服务商栏里没有「${name}」`);
  fireEvent.click(card);
};

const openDetail = (
  overrides: Partial<ProviderConnectionData> = {},
): void => {
  render(<Harness {...overrides} />);
  selectProviderInRail('我的绘图服务');
};

const dialog = () => within(screen.getByRole('dialog', { name: '添加模型到「我的绘图服务」' }));

/** 打开某一行模型的「⋯」菜单（2026-10-19 起行内动作收进菜单） */
const openRowMenu = (modelId: string): void => {
  fireEvent.keyDown(screen.getByRole('button', { name: `「${modelId}」的操作` }), { key: 'Enter' });
};

const editDialog = () => within(screen.getByRole('dialog', { name: '修改「my-image-model」的模型配置' }));

/**
 * 「添加模型」恒先出二级选择（2026-09-29 起连接级预选摘除）：选「生成模型」开合并弹窗。
 * 下拉对键盘可见：键盘打开（Radix 菜单不响应 jsdom 里的裸 click）。
 */
const openAddModelDialog = (): void => {
  fireEvent.keyDown(screen.getByRole('button', { name: '添加模型' }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('menuitem', { name: '生成模型' }));
};

/** 在弹窗里选「接口格式」（下拉渲染在 portal，选项按 body 级查询；jsdom 无 PointerEvent：键盘开下拉，click 选中）。 */
const chooseFamilyAdapter = async (): Promise<void> => {
  fireEvent.keyDown(dialog().getByLabelText('接口格式'), { key: 'Enter' });
  // 接口格式选项来自列表接口（异步装载）：等它出现再点，不假设同步就绪。
  fireEvent.click(await screen.findByRole('option', { name: 'OpenAI Image' }));
};

/** 等素材位能力读完：勾选框出现才算放行提交（读不到能力时不猜清单）。 */
const waitForMediaSlots = async (): Promise<void> => {
  await waitFor(() => {
    expect(dialog().getByRole('checkbox', { name: '参考图' })).toBeInTheDocument();
  });
};

/** 与真实列表响应同形（contracts 的 CustomGenerationModelSchema 在客户端 parse 它） */
const declaredRecord: CustomGenerationModel = {
  model_id: 'my-image-model',
  record_id: 'up_dep_rec1',
  connection_id: generationConnection.connection_id,
  remote_model_id: 'my-image-model',
  family_adapter_id: 'openai-image-v1',
  accepted_media_slots: ['reference_image'],
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
    await chooseFamilyAdapter();
    fireEvent.change(dialog().getByLabelText('服务商那边的模型 ID'), { target: { value: 'remote-name' } });
    // 素材位按所选族能力渲染（openai 族只有「参考图」），读到之后才放行提交
    await waitFor(() => {
      expect(dialog().getByRole('checkbox', { name: '参考图' })).toBeInTheDocument();
    });
    fireEvent.click(dialog().getByRole('checkbox', { name: '参考图' }));
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
      accepted_media_slots: ['reference_image'],
    });
    // active 接入由后端在创建内写入：没有第二次写入（也不再有任何接入载体端点的调用——
    // /api/model-deployments 已随部署载体退场删除）
    expect(fetchFn.mock.calls.some(([input]) => String(input).includes('/api/active-routes'))).toBe(false);
  });

  it('远端模型名留空：请求体不带 remote_model_id（契约缺省回落模型 ID），能力勾选照常携带', async () => {
    const fetchFn = stubFetch();
    openDetail();

    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    await chooseFamilyAdapter();
    await waitFor(() => {
      expect(dialog().getByRole('checkbox', { name: '参考图' })).not.toBeChecked();
    });
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(bodyOf(fetchFn, '/api/custom-generation-models', 'POST')).toEqual({
        model_id: 'my-image-model',
        connection_id: generationConnection.connection_id,
        family_adapter_id: 'openai-image-v1',
        accepted_media_slots: [],
      });
    });
  });

  it('重名撞上后端 409 兜底：给「换名字」的可读提示，弹层留着', async () => {
    stubFetch({ failCreate: true });
    openDetail();

    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    await chooseFamilyAdapter();
    await waitForMediaSlots();
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
    await chooseFamilyAdapter();
    await waitForMediaSlots();
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(dialog().getByRole('alert')).toHaveTextContent(
        '这个接口格式不接受「参考图」这类素材',
      );
    });
    expect(screen.getByRole('dialog', { name: '添加模型到「我的绘图服务」' })).toBeInTheDocument();
  });

  it('要添加的模型已经在这个服务商上：提交前说清，不发写入请求', async () => {
    const fetchFn = stubFetch();
    openDetail({ customGenerationModels: [declaredRecord] });

    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    await chooseFamilyAdapter();
    await waitForMediaSlots();
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
    openDetail({ customGenerationModels: [declaredRecord] });

    openRowMenu('my-image-model');
    fireEvent.click(screen.getByRole('menuitem', { name: '删除模型' }));

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
    openDetail({ customGenerationModels: [declaredRecord] });

    openRowMenu('my-image-model');
    fireEvent.click(screen.getByRole('menuitem', { name: '删除模型' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '删除模型' })).getByRole('button', { name: '取消' }));

    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
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
    await chooseFamilyAdapter();
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
        accepted_media_slots: [],
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
    await chooseFamilyAdapter();
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

  it('读不到参数描述：素材位也无从判断，给一行原因并拦下添加（不猜一份清单落库）', async () => {
    const fetchFn = stubFetch({ failTemplate: true });
    openDetail();

    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    await chooseFamilyAdapter();

    // 素材位能力与参数描述同源于族模板：读不到时两处各自给原因，添加被拦下
    await waitFor(() => {
      expect(
        dialog().getByText('暂时读不到这个接口格式能用的素材。关掉这个窗口后点「刷新」再试。'),
      ).toBeInTheDocument();
    });
    fireEvent.click(dialog().getByRole('button', { name: '高级参数自定义' }));
    await waitFor(() => {
      expect(dialog().getByText('暂时读不到可调的参数，这项设置用不了；收起再展开可以再试。其他设置不受影响。')).toBeInTheDocument();
    });

    fireEvent.click(dialog().getByRole('button', { name: '添加' }));
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});

describe('生成族服务商：素材位行的参数设置', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 打开添加弹层 → 选接口格式 → 勾上参考图 → 展开高级区（装载完成以普通参数行出现为准）。 */
  const openAdvanced = async (): Promise<void> => {
    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    await chooseFamilyAdapter();
    // 素材位行只在勾选后出现（族级描述符不掌握勾选）：先勾参考图，再看它的参数行
    await waitForMediaSlots();
    fireEvent.click(dialog().getByRole('checkbox', { name: '参考图' }));
    fireEvent.click(dialog().getByRole('button', { name: '高级参数自定义' }));
    await waitFor(() => {
      expect(dialog().getByText('图片画质')).toBeInTheDocument();
    });
  };

  it('素材位行只有「发送名称」「最多几张」：没有启用开关、可选值、默认值，内部标识不上屏', async () => {
    stubFetch();
    openDetail();
    await openAdvanced();

    const mediaRow = dialog().getByRole('group', { name: '参考图' });
    expect(within(mediaRow).getByText('发送名称')).toBeInTheDocument();
    expect(within(mediaRow).getByText('最多几张')).toBeInTheDocument();
    // 是否接收这类素材由上方勾选清单管，行内不再给第二个开关
    expect(within(mediaRow).queryByRole('switch')).not.toBeInTheDocument();
    // 素材位没有枚举/默认值/预设这些维度
    expect(within(mediaRow).queryByText('可选值')).not.toBeInTheDocument();
    expect(within(mediaRow).queryByText('默认值')).not.toBeInTheDocument();
    expect(within(mediaRow).queryByText('分辨率档位')).not.toBeInTheDocument();
    expect(dialog().queryByText('reference_image')).not.toBeInTheDocument();
    expect(dialog().queryByText('referenceImage')).not.toBeInTheDocument();
  });

  it('改发送名称写入 wire_name', async () => {
    const fetchFn = stubFetch();
    openDetail();
    await openAdvanced();

    const wireInput = dialog().getByLabelText('「参考图」的发送名称');
    fireEvent.change(wireInput, { target: { value: 'image' } });
    fireEvent.blur(wireInput);
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(bodyOf(fetchFn, '/api/custom-generation-models', 'POST')).toEqual({
        model_id: 'my-image-model',
        connection_id: generationConnection.connection_id,
        family_adapter_id: 'openai-image-v1',
        accepted_media_slots: ['reference_image'],
        parameter_overrides: {
          official: [{ field_key: 'referenceImage', wire_name: 'image' }],
          custom: [],
        },
      });
    });
  });

  it('清空发送名称回到默认：覆盖里不留这个维度', async () => {
    const fetchFn = stubFetch();
    openDetail();
    await openAdvanced();

    const wireInput = dialog().getByLabelText('「参考图」的发送名称');
    fireEvent.change(wireInput, { target: { value: 'image' } });
    fireEvent.blur(wireInput);
    fireEvent.change(wireInput, { target: { value: '' } });
    fireEvent.blur(wireInput);
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      // 清空后没有任何改动：请求体不带 parameter_overrides（与从未改过一致）
      expect(bodyOf(fetchFn, '/api/custom-generation-models', 'POST')).toEqual({
        model_id: 'my-image-model',
        connection_id: generationConnection.connection_id,
        family_adapter_id: 'openai-image-v1',
        accepted_media_slots: ['reference_image'],
      });
    });
  });

  it('填最多几张写入 media_max_files', async () => {
    const fetchFn = stubFetch();
    openDetail();
    await openAdvanced();

    fireEvent.change(dialog().getByLabelText('「参考图」的最多几张'), { target: { value: '9' } });
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(bodyOf(fetchFn, '/api/custom-generation-models', 'POST')).toEqual({
        model_id: 'my-image-model',
        connection_id: generationConnection.connection_id,
        family_adapter_id: 'openai-image-v1',
        accepted_media_slots: ['reference_image'],
        parameter_overrides: {
          official: [{ field_key: 'referenceImage', media_max_files: 9 }],
          custom: [],
        },
      });
    });
  });

  it('最多几张填 0、负数或小数：行内提示且不写入', async () => {
    const fetchFn = stubFetch();
    openDetail();
    await openAdvanced();

    const maxInput = dialog().getByLabelText('「参考图」的最多几张');
    for (const invalid of ['0', '-1', '1.5']) {
      fireEvent.change(maxInput, { target: { value: invalid } });
      expect(dialog().getByRole('alert')).toHaveTextContent('最多几张要填 1 或更大的整数');
    }
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      // 不合法的张数没有被写入：请求体不带 parameter_overrides
      expect(bodyOf(fetchFn, '/api/custom-generation-models', 'POST')).toEqual({
        model_id: 'my-image-model',
        connection_id: generationConnection.connection_id,
        family_adapter_id: 'openai-image-v1',
        accepted_media_slots: ['reference_image'],
      });
    });
  });

  it('未勾选的素材位不出现在高级参数区：勾上才出现，取消后又消失', async () => {
    stubFetch();
    openDetail();
    openAddModelDialog();
    fireEvent.change(dialog().getByLabelText('模型 ID'), { target: { value: 'my-image-model' } });
    await chooseFamilyAdapter();
    await waitForMediaSlots();

    fireEvent.click(dialog().getByRole('button', { name: '高级参数自定义' }));
    await waitFor(() => {
      expect(dialog().getByText('图片画质')).toBeInTheDocument();
    });
    // 还没勾参考图：它的参数行不出现（族描述符里有这一行，但记录当前不接受它）
    expect(dialog().queryByRole('group', { name: '参考图' })).not.toBeInTheDocument();

    fireEvent.click(dialog().getByRole('checkbox', { name: '参考图' }));
    expect(dialog().getByRole('group', { name: '参考图' })).toBeInTheDocument();

    fireEvent.click(dialog().getByRole('checkbox', { name: '参考图' }));
    expect(dialog().queryByRole('group', { name: '参考图' })).not.toBeInTheDocument();
  });

  it('取消勾选后该位的覆盖不进请求体；同一次弹层内勾回来填过的值还在', async () => {
    const fetchFn = stubFetch();
    openDetail();
    await openAdvanced();

    fireEvent.change(dialog().getByLabelText('「参考图」的最多几张'), { target: { value: '9' } });
    const slotCheckbox = dialog().getByRole('checkbox', { name: '参考图' });
    fireEvent.click(slotCheckbox);
    expect(dialog().queryByRole('group', { name: '参考图' })).not.toBeInTheDocument();

    // 勾回来：行重新出现，填过的张数仍在（弹层内保留输入，不静默丢用户的值）
    fireEvent.click(slotCheckbox);
    const maxInput = dialog().getByLabelText('「参考图」的最多几张') as HTMLInputElement;
    expect(maxInput.value).toBe('9');

    // 再取消并保存：该位与它的覆盖都不进请求体（后端会按勾选清单校验，带上必然被整次拒绝）
    fireEvent.click(dialog().getByRole('checkbox', { name: '参考图' }));
    fireEvent.click(dialog().getByRole('button', { name: '添加' }));

    await waitFor(() => {
      expect(bodyOf(fetchFn, '/api/custom-generation-models', 'POST')).toEqual({
        model_id: 'my-image-model',
        connection_id: generationConnection.connection_id,
        family_adapter_id: 'openai-image-v1',
        accepted_media_slots: [],
      });
    });
  });
});

describe('生成族服务商：编辑已添加模型（素材位 + 参数覆盖）', () => {
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

  it('接口格式只读、素材位可改：不出现接口格式下拉，取消勾选后保存按新清单整体替换', async () => {
    const fetchFn = stubFetch();
    openDetail({ customGenerationModels: [declaredRecord] });

    openRowMenu('my-image-model');
    fireEvent.click(screen.getByRole('menuitem', { name: '修改配置' }));

    // 接口格式创建后不可变（换族等于换一个模型）：只读展示名，不给下拉。
    // 展示名来自接口格式列表（异步装载），等它到位。
    expect(await editDialog().findByText('OpenAI Image')).toBeInTheDocument();
    expect(editDialog().queryByLabelText('接口格式')).not.toBeInTheDocument();
    expect(editDialog().queryByRole('combobox')).not.toBeInTheDocument();

    // 素材位按该族能力渲染，并回填记录里已勾的那一位
    await waitFor(() => {
      expect(editDialog().getByRole('checkbox', { name: '参考图' })).toBeChecked();
    });
    fireEvent.click(editDialog().getByRole('checkbox', { name: '参考图' }));
    expect(editDialog().getByRole('checkbox', { name: '参考图' })).not.toBeChecked();

    fireEvent.click(editDialog().getByRole('button', { name: '保存' }));
    await waitFor(() => {
      const put = fetchFn.mock.calls.find(
        ([input, init]) =>
          String(input).includes('/api/custom-generation-models/my-image-model') && init?.method === 'PUT',
      );
      expect(put).toBeDefined();
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({
        accepted_media_slots: [],
        parameter_overrides: { official: [], custom: [] },
      });
    });
  });

  it('取消勾选素材位后保存：该位的覆盖被裁掉，其它覆盖原样保留', async () => {
    const fetchFn = stubFetch();
    openDetail({
      customGenerationModels: [
        {
          ...declaredRecord,
          parameter_overrides: {
            official: [
              { field_key: 'referenceImage', media_max_files: 9 },
              { field_key: 'format', wire_name: 'image_format' },
            ],
            custom: [],
          },
        },
      ],
    });

    openRowMenu('my-image-model');
    fireEvent.click(screen.getByRole('menuitem', { name: '修改配置' }));

    await waitFor(() => {
      expect(editDialog().getByRole('checkbox', { name: '参考图' })).toBeChecked();
    });
    fireEvent.click(editDialog().getByRole('checkbox', { name: '参考图' }));
    fireEvent.click(editDialog().getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const put = fetchFn.mock.calls.find(
        ([input, init]) =>
          String(input).includes('/api/custom-generation-models/my-image-model') && init?.method === 'PUT',
      );
      expect(put).toBeDefined();
      // 未勾选位留下的覆盖不进请求体：后端按本次勾选的模板校验，带上它整次保存会被拒
      expect(JSON.parse(String(put?.[1]?.body))).toEqual({
        accepted_media_slots: [],
        parameter_overrides: {
          official: [{ field_key: 'format', wire_name: 'image_format' }],
          custom: [],
        },
      });
    });
  });

  it('自建记录行有「修改」：弹层回填现有覆盖，保存走 PUT 整体替换', async () => {
    const fetchFn = stubFetch();
    openDetail({ customGenerationModels: [declaredWithOverrides] });

    openRowMenu('my-image-model');
    fireEvent.click(screen.getByRole('menuitem', { name: '修改配置' }));

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
        accepted_media_slots: ['reference_image'],
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
});
