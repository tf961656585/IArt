import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type {
  CustomChatModel,
  ExecutableModelDirectoryEntry,
  ModelDeployment,
  ProtocolAdapterId,
  ProviderConnection,
} from '@iart/contracts';

import { ProviderDetail } from '../ProviderDetail';

/**
 * 服务商详情入口与模型清单（spec 03 §6.1「记录即接入」、provider-config-ui-design §4.3）。
 *
 * 2026-09-26 界面收敛后每条可编辑的连接只有一个「添加模型」入口；2026-09-29 起连接级
 * 预选摘除（接口类型只在添加模型时配置），入口恒先出二级选择（生成模型 / 对话模型），
 * 选完交给容器开对应表单——不再有「有预选直接开弹窗」的分流。
 * 详情也不再显示「默认接口类型」只读行。
 * retired 连接不给任何入口（不提供必然失败的入口，也不解释为什么没有，spec §7.5）。
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

/** 没有接口类型字段的连接（连接级预选摘除后的常态形状）。 */
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

const deployment = (modelId: string): ModelDeployment => ({
  deployment_id: `up_dep_${modelId}`,
  model_id: modelId,
  connection_id: 'up_conn_plain',
  remote_model_id: modelId,
  created_at: '2026-09-24T00:00:00.000Z',
  updated_at: '2026-09-24T00:00:00.000Z',
});

const renderDetail = (
  connection: ProviderConnection,
  {
    lifecycle,
    catalog = [],
    chatCatalog = [],
    deployments = [],
    customChatModels = [],
    modelListUnavailable = false,
    activeRoutes = {},
  }: {
    lifecycle?: ProviderConnection['lifecycle'];
    catalog?: ExecutableModelDirectoryEntry[];
    chatCatalog?: ExecutableModelDirectoryEntry[];
    deployments?: ModelDeployment[];
    customChatModels?: Parameters<typeof ProviderDetail>[0]['customChatModels'];
    modelListUnavailable?: boolean;
    activeRoutes?: Record<string, string>;
  } = {},
): void => {
  const base = connection;
  render(
    <ProviderDetail
      connection={lifecycle === undefined ? base : { ...base, lifecycle }}
      catalog={catalog}
      chatCatalog={chatCatalog}
      deployments={deployments}
      customChatModels={customChatModels}
      modelListUnavailable={modelListUnavailable}
      customGenerationModels={[]}
      activeRoutes={activeRoutes}
      onEdit={noop}
      onCredential={noop}
      onToggle={noop}
      onClearCredential={noop}
      onDelete={noop}
      onAddModelByKind={noop}
      onRenameModel={noop}
      onRemoveModel={noop}
      onEditChatModel={noop}
      agentDefaultModelId={null}
      onToggleAgentDefault={noop}
      generationDefaultModelId={null}
      onToggleGenerationDefault={noop}
      onDeleteGenerationModel={noop}
      onEditGenerationModel={noop}
    />,
  );
};

describe('服务商详情「添加模型」入口', () => {
  it('有预选历史的连接也是二级选择：点「生成模型」交回容器（连接级预选已摘除，不再直接开弹窗）', () => {
    const onAddModelByKind = vi.fn();
    render(
      <ProviderDetail
        connection={connectionWith('openai-image-v1')}
        catalog={[]}
        chatCatalog={[]}
        deployments={[]}
        customChatModels={[]}
        modelListUnavailable={false}
        customGenerationModels={[]}
        activeRoutes={{}}
        onEdit={noop}
        onCredential={noop}
        onToggle={noop}
        onClearCredential={noop}
        onDelete={noop}
        onAddModelByKind={onAddModelByKind}
        onRenameModel={noop}
        onRemoveModel={noop}
        onEditChatModel={noop}
        agentDefaultModelId={null}
        onToggleAgentDefault={noop}
        generationDefaultModelId={null}
        onToggleGenerationDefault={noop}
        onDeleteGenerationModel={noop}
        onEditGenerationModel={noop}
      />,
    );

    // 二级选择跟着入口走：键盘打开（入口对键盘可见），「生成模型」交回 generation
    fireEvent.keyDown(screen.getByRole('button', { name: '添加模型' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: '生成模型' }));
    expect(onAddModelByKind).toHaveBeenCalledWith('generation');
  });

  it('没有接口类型字段的连接：「添加模型」同样先出二级选择，选「对话模型」交回容器', () => {
    const onAddModelByKind = vi.fn();
    render(
      <ProviderDetail
        connection={connectionWithoutDefault}
        catalog={[]}
        chatCatalog={[]}
        deployments={[]}
        customChatModels={[]}
        modelListUnavailable={false}
        customGenerationModels={[]}
        activeRoutes={{}}
        onEdit={noop}
        onCredential={noop}
        onToggle={noop}
        onClearCredential={noop}
        onDelete={noop}
        onAddModelByKind={onAddModelByKind}
        onRenameModel={noop}
        onRemoveModel={noop}
        onEditChatModel={noop}
        agentDefaultModelId={null}
        onToggleAgentDefault={noop}
        generationDefaultModelId={null}
        onToggleGenerationDefault={noop}
        onDeleteGenerationModel={noop}
        onEditGenerationModel={noop}
      />,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: '添加模型' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: '对话模型' }));
    expect(onAddModelByKind).toHaveBeenCalledWith('chat');
  });
});

describe('服务商详情只读信息', () => {
  it('详情不再显示「默认接口类型」行：接口类型只属于模型，添加模型时再配置', () => {
    renderDetail(connectionWith('openai-image-v1'));
    expect(screen.queryByText('默认接口类型')).not.toBeInTheDocument();
    expect(screen.getByText('服务地址')).toBeInTheDocument();
    expect(screen.getByText('密钥')).toBeInTheDocument();
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

  it('自建对话记录行有「修改」与「设为 Agent 默认」，没有行内改名与「移除」（记录即接入）', () => {
    renderDetail(chatConnection, { customChatModels: [chatRecord] });

    expect(screen.getByText('my-llm')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修改「my-llm」的配置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '把「my-llm」设为 Agent 默认模型' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '移除' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('my-llm 的模型 ID')).not.toBeInTheDocument();
  });

  it('行状态按行类型选目录：对话行查对话目录，自带包行查可执行目录（连接可混放两种模型）', () => {
    // 两条行各在「自己的」目录里：对话行只进对话目录，自带包行只进可执行目录。
    // 单一目录判全场的旧口径会把其中一条判成「状态未知」，这里钉住新口径
    renderDetail(connectionWithoutDefault, {
      catalog: [catalogEntry('gpt-image-1')],
      chatCatalog: [catalogEntry('my-llm')],
      deployments: [deployment('gpt-image-1')],
      customChatModels: [chatRecord],
      activeRoutes: { 'gpt-image-1': 'up_dep_gpt-image-1' },
    });

    expect(screen.getAllByText('可用')).toHaveLength(2);
  });

  it('没有模型时空态指向「添加模型」', () => {
    renderDetail(chatConnection);

    expect(
      screen.getByText('这个服务商还没有模型。点上面的「添加模型」加几个。'),
    ).toBeInTheDocument();
  });

  it('清单读不到时与「还没有模型」分开说：任何连接都让用户刷新，不引他去重新添加', () => {
    // 用生成族连接渲染：判定不再限定对话连接（连接级预选摘除后的通用口径）
    renderDetail(connectionWith('openai-image-v1'), { modelListUnavailable: true });

    expect(screen.getByText('暂时读不到模型清单，点「刷新」再试。')).toBeInTheDocument();
  });

  it('退役连接：不提供任何编辑入口，空态也不给动作指路（按钮不存在本身就是答案）', () => {
    renderDetail(chatConnection, { lifecycle: 'retired' });

    expect(screen.queryByRole('button', { name: '添加模型' })).not.toBeInTheDocument();
    expect(screen.getByText('这个服务商还没有模型。')).toBeInTheDocument();
  });
});
