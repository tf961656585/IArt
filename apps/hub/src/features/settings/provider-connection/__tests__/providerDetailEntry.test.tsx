import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type {
  CustomChatModel,
  CustomGenerationModel,
  ExecutableModelDirectoryEntry,
  ProtocolAdapterId,
  ProviderConnection,
} from '@iart/contracts';

import { ProviderDetail } from '../ProviderDetail';
import type { ModelRow } from '../ModelTable';

/**
 * 服务商详情入口与模型清单（spec 03 §6.1「记录即接入」、provider-config-ui-design §4.3）。
 *
 * 2026-09-26 界面收敛后每条可编辑的连接只有一个「添加模型」入口；2026-09-29 起连接级
 * 预选摘除（接口格式只在添加模型时配置），入口恒先出二级选择（生成模型 / 对话模型），
 * 选完交给容器开对应表单——不再有「有预选直接开弹窗」的分流。
 * 详情也不再显示「默认接口格式」只读行。
 * retired 连接不给任何入口（不提供必然失败的入口，也不解释为什么没有，spec §7.5）。
 *
 * 2026-10-19 形态变更（设置页迭代 B2）：模型清单由两行卡改为 52px 单行表格，行内动作收进
 * 「⋯」菜单，破坏性项在菜单内独立成组。本文件的断言随之改为「菜单项可达」——
 * 保护的行为不变（记录即接入、按行类型选目录、三态分离、retired 无入口），
 * 变的是触发点位置。
 *
 * 2026-10-19 部署载体退场：模型行不再分来源（没有 `kind: 'installed'`），「自带模型行」的
 * 那一组用例（行内改名、从本服务商移除、按种行类型选目录的对照）随之删除——它们保护的
 * 「两族行各查自己的目录」由对话行 + 生成行两条记录行继续钉住；而「服务商模型 ID 可改」
 * 这条能力本身已随载体退场（记录上的远端模型名创建后不可变，spec 03 §6.1）。
 */

const connectionWith = (protocolAdapterId: ProtocolAdapterId): ProviderConnection => ({
  connection_id: `up_conn_${protocolAdapterId}`,
  display_name: '我的服务商',
  protocol_adapter_id: protocolAdapterId,
  base_url: 'https://api.example.com',
  has_credential: true,
  lifecycle: 'enabled',
  revision: 1,
  created_at: '2026-09-24T00:00:00.000Z',
  updated_at: '2026-09-24T00:00:00.000Z',
});

/** 没有接口格式字段的连接（连接级预选摘除后的常态形状）。 */
const connectionWithoutDefault: ProviderConnection = {
  connection_id: 'up_conn_plain',
  display_name: '我的服务商',
  base_url: 'https://api.example.com',
  has_credential: true,
  lifecycle: 'enabled',
  revision: 1,
  created_at: '2026-09-24T00:00:00.000Z',
  updated_at: '2026-09-24T00:00:00.000Z',
};

const noop = () => undefined;

const catalogEntry = (modelId: string, deployable = true): ExecutableModelDirectoryEntry => ({
  model_id: modelId,
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: { input_modalities: ['text'], output_modalities: ['image'] },
  parameter_schema: { fields: [], required_fields: [] },
  deployment: {
    has_active_deployment: false,
    active_deployment_id: null,
    deployable,
    failure_code: deployable ? 'none' : 'no_active_deployment',
  },
});

/** 详情渲染器：把「模型清单的输入」整成 modelTable（与 ProviderDetail 的 props 形状对齐）。 */
const renderDetail = (
  connection: ProviderConnection,
  {
    lifecycle,
    catalog = [],
    chatCatalog = [],
    customChatModels = [],
    customGenerationModels = [],
    modelListUnavailable = false,
    onAddModelByKind = noop,
  }: {
    lifecycle?: ProviderConnection['lifecycle'];
    catalog?: ExecutableModelDirectoryEntry[];
    chatCatalog?: ExecutableModelDirectoryEntry[];
    customChatModels?: CustomChatModel[];
    customGenerationModels?: CustomGenerationModel[];
    modelListUnavailable?: boolean;
    onAddModelByKind?: (kind: 'generation' | 'chat') => void;
  } = {},
): void => {
  const withLifecycle = lifecycle === undefined ? connection : { ...connection, lifecycle };
  render(
    <ProviderDetail
      connection={withLifecycle}
      onReload={noop}
      onEdit={noop}
      onCredential={noop}
      onToggle={noop}
      onClearCredential={noop}
      onDelete={noop}
      onAddModelByKind={onAddModelByKind}
      modelTable={{
        rows: [
          ...customChatModels.map((item): ModelRow => ({ kind: 'custom-chat', record: item })),
          ...customGenerationModels.map((item): ModelRow => ({ kind: 'custom-generation', record: item })),
        ],
        catalog,
        chatCatalog,
        editable: withLifecycle.lifecycle !== 'retired',
        modelListUnavailable,
        interfaceRecipes: [],
        interfaceRecipesUnavailable: false,
        agentDefaultModelId: null,
        generationDefaultModelId: null,
        onToggleAgentDefault: noop,
        onToggleGenerationDefault: noop,
        onEditChatModel: noop,
        onEditGenerationModel: noop,
        onDeleteGenerationModel: noop,
      }}
    />,
  );
};

describe('服务商详情「添加模型」入口', () => {
  it('有预选历史的连接也是二级选择：点「生成模型」交回容器（连接级预选已摘除，不再直接开弹窗）', () => {
    const onAddModelByKind = vi.fn();
    renderDetail(connectionWith('openai-image-v1'), { onAddModelByKind });

    // 二级选择跟着入口走：键盘打开（入口对键盘可见），「生成模型」交回 generation
    fireEvent.keyDown(screen.getByRole('button', { name: '添加模型' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: '生成模型' }));
    expect(onAddModelByKind).toHaveBeenCalledWith('generation');
  });

  it('没有接口格式字段的连接：「添加模型」同样先出二级选择，选「对话模型」交回容器', () => {
    const onAddModelByKind = vi.fn();
    renderDetail(connectionWithoutDefault, { onAddModelByKind });

    fireEvent.keyDown(screen.getByRole('button', { name: '添加模型' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: '对话模型' }));
    expect(onAddModelByKind).toHaveBeenCalledWith('chat');
  });
});

describe('服务商详情只读信息', () => {
  it('详情不再显示「默认接口格式」行：接口格式只属于模型，添加模型时再配置', () => {
    renderDetail(connectionWith('openai-image-v1'));
    expect(screen.queryByText('默认接口格式')).not.toBeInTheDocument();
    // 详情头第二行 = 地址 · 密钥状态（2026-10-19 起不再用 label/value 双行字段表，
    // 且**不复读模型数**——模型清单就在正下方逐行可见）
    expect(screen.getByText('https://api.example.com')).toBeInTheDocument();
    expect(screen.getByText('密钥已保存')).toBeInTheDocument();
    expect(screen.queryByText(/个模型$/)).not.toBeInTheDocument();
  });
});

describe('服务商详情模型行与空态', () => {
  const chatConnection = connectionWith('openai-chat-completions-v1');

  const chatRecord: CustomChatModel = {
    model_id: 'my-llm',
    record_id: 'up_dep_rec1',
    connection_id: 'up_conn_plain',
    remote_model_id: 'my-llm',
    protocol_adapter_id: 'openai-chat-completions-v1',
    context_window_tokens: 128000,
    max_output_tokens: null,
    enabled_thinking_tiers: [],
    default_thinking_tier: null,
    created_at: '2026-09-25T00:00:00.000Z',
  };

  const generationRecord: CustomGenerationModel = {
    model_id: 'gpt-image-1',
    record_id: 'up_dep_rec2',
    connection_id: 'up_conn_plain',
    remote_model_id: 'gpt-image-1',
    family_adapter_id: 'openai-image-v1',
    accepted_media_slots: [],
    parameter_overrides: { official: [], custom: [] },
    created_at: '2026-09-25T00:00:00.000Z',
  };

  it('对话记录行：菜单里有「修改配置」、默认列是星标，没有「从本服务商移除」与行内改名', () => {
    renderDetail(chatConnection, { customChatModels: [chatRecord] });

    // 模型 ID 在单元格里出现一次（另一处是远程 ID 列，同为 'my-llm'，故用 all）
    expect(screen.getAllByText('my-llm').length).toBeGreaterThan(0);
    // 默认列是星标按钮（不再占用动作区的文字按钮）
    expect(screen.getByRole('button', { name: '把「my-llm」设为 Agent 默认模型' })).toBeInTheDocument();
    // 记录的线上模型名不可改（spec 03 §6.1：改它等于换一个远端模型，走删除后重建）
    expect(screen.queryByRole('button', { name: '修改「my-llm」的服务商模型 ID' })).not.toBeInTheDocument();

    // 行内动作收进「⋯」菜单
    fireEvent.keyDown(screen.getByRole('button', { name: '「my-llm」的操作' }), { key: 'Enter' });
    expect(screen.getByRole('menuitem', { name: '修改配置' })).toBeInTheDocument();
    // 没有「从本服务商移除」这一层：模型只有记录一处载体，删掉即消失
    expect(screen.queryByRole('menuitem', { name: '从本服务商移除' })).not.toBeInTheDocument();
  });

  it('行状态按行类型选目录：对话行查对话目录，生成行查可执行目录（连接可混放两种模型）', () => {
    // 两条行各在「自己的」目录里：对话行只进对话目录，生成行只进可执行目录。
    // 单一目录判全场的旧口径会把其中一条判成「状态未知」，这里钉住新口径。
    renderDetail(connectionWithoutDefault, {
      catalog: [catalogEntry('gpt-image-1')],
      chatCatalog: [catalogEntry('my-llm')],
      customChatModels: [chatRecord],
      customGenerationModels: [generationRecord],
    });

    expect(screen.getAllByText('可用')).toHaveLength(2);
  });

  it('没有模型时空态指向「添加模型」', () => {
    renderDetail(chatConnection);

    expect(screen.getByText('这个服务商还没有模型。')).toBeInTheDocument();
    // 入口只有详情头一处（同屏不得出现两个同名按钮）：空态只指路，不再挂第二个按钮
    expect(screen.getAllByRole('button', { name: '添加模型' })).toHaveLength(1);
  });

  it('清单读不到时与「还没有模型」分开说：任何连接都让用户刷新，不引他去重新添加', () => {
    // 用生成族连接渲染：判定不再限定对话连接（连接级预选摘除后的通用口径）
    renderDetail(connectionWith('openai-image-v1'), { modelListUnavailable: true });

    expect(screen.getByText('暂时读不到模型清单，点「刷新」再试。')).toBeInTheDocument();
  });

  it('退役连接：不提供任何编辑入口，空态也不给动作指路（按钮不存在本身就是答案）', () => {
    renderDetail(chatConnection, { lifecycle: 'retired' });

    expect(screen.queryByRole('button', { name: '添加模型' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '服务商操作' })).not.toBeInTheDocument();
    expect(screen.getByText('这个服务商还没有模型。')).toBeInTheDocument();
  });
});
