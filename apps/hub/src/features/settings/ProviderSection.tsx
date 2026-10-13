import { useEffect, useState } from 'react';
import { Button } from '@iart/ui';
import {
  CUSTOM_THINKING_TIER_LIMIT,
  type CustomChatModel,
  type ProviderConnection,
  type ThinkingTierPool,
} from '@iart/contracts';
import { Server } from 'lucide-react';
import { SettingsSection } from './components/SettingsSection';
import { AddModelDialog, type ModelMappingDraft } from './provider-connection/AddModelDialog';
import { ConfirmDialog } from './provider-connection/ConfirmDialog';
import { CredentialDialog } from './provider-connection/CredentialDialog';
import {
  CustomModelDialog,
  type CustomModelDialogPayload,
  type CustomModelThinkingContext,
} from './provider-connection/CustomModelDialog';
import { ProviderDetail } from './provider-connection/ProviderDetail';
import { ProviderNoticeBar, StatusPill, type BindingTone } from './provider-connection/ProviderNoticeBar';
import { ProviderFormDialog, type ProviderFormPayload } from './provider-connection/ProviderFormDialog';
import {
  confirmMessage,
  confirmTitle,
  type ConfirmTarget,
} from './provider-connection/providerConfirmMessages';
import { useProviderData } from './provider-connection/ProviderDataContext';
import { describeError, isConflictError } from './provider-connection/useProviderConnectionData';
import { useGenerationModelManagement } from './provider-connection/useGenerationModelManagement';

/**
 * 设置页「服务商」区域：一个服务商列表 + 详情同页。
 *
 * 口径：用户要做的两件事都在这一页完成——① 添加一个服务商（名称 + 地址 + 密钥）；
 * ② 把模型加进来：每条连接只有一个「添加模型」入口（2026-09-26 界面收敛），
 * 恒先出二级选择（生成模型 / 对话模型；2026-09-29 起连接级预选摘除，接口类型只在
 * 添加模型时配置）：生成侧开合并弹窗（AddModelDialog：软件自带的模型在「软件自带的模型」
 * 区块里勾选，软件里没有的模型在「自定义接口的模型」区块里一次写入），对话侧开自建表单弹层。
 * 因此不再有并列的第二个页面，也不再需要在两页之间来回跳。
 *
 * 自建模型与思考档位都**不在页面底部单独成块**（2026-09-18）：模型列表已在服务商详情里按
 * 服务商陈列，档位只在配置某个模型时才被关心，把池子再列一遍只是同屏重复。管理跟着对象走——
 * 删除模型在模型自己的「修改」弹层里（对话侧），生成侧删除入口长在生成族模型行上；
 * 增删自定义档位在档位字段里；页面只留「服务商 → 模型」一条链。
 *
 * 界面默认不印解释文字：字段说明挂在「?」上（见 InfoHint），只有首次配置时才需要看。
 */

/**
 * 自建模型表单的打开目标：同一时刻只可能开一个，所以是一个状态而不是两个。
 *
 * `create` 带上要添加到的那条连接（弹层标题要显示服务商名，提交时用它作接入归属），
 * `edit` 带上要改的那条模型记录——
 * 能力值与档位都随记录走（spec 03 §6.1「记录即接入」）。
 */
type CustomModelTarget =
  | { kind: 'create'; connection: ProviderConnection }
  | { kind: 'edit'; model: CustomChatModel }
  | null;

/**
 * 弹层的思考档位上下文：入口都落在一个连接上——`create` 是即将添加到的连接，
 * `edit` 是记录归属的连接。档位随模型记录走（记录归属一条连接，模型不复用到另一条连接），
 * 所以它随连接上下文传入，不在表单 mode 里。档位的可表达性按记录/表单当前的接口类型判定
 * （CustomModelDialog 内按契约注册表取），这里不再随连接传适配器。
 */
function thinkingContextFor(
  target: CustomModelTarget,
  data: {
    connections: ProviderConnection[];
    pool: ThinkingTierPool;
    poolUnavailable: boolean;
    onAddCustom: (name: string) => Promise<boolean>;
    onDeleteCustom: (tier: string) => void;
  },
): CustomModelThinkingContext | null {
  if (target === null) return null;
  const connectionId = target.kind === 'create' ? target.connection.connection_id : target.model.connection_id;
  const connection = data.connections.find((item) => item.connection_id === connectionId) ?? null;
  // 连接读不到（记录归属的连接已不在列表里）时不提供档位候选：写进去也没有连接承载它。
  if (connection === null) {
    console.debug('[provider-connection] 该记录归属的连接不在列表里，本次不提供思考档位', connectionId);
    return null;
  }
  return {
    pool: data.pool,
    unavailable: data.poolUnavailable,
    initialTiers: target.kind === 'create' ? [] : target.model.enabled_thinking_tiers,
    initialDefaultTier: target.kind === 'create' ? null : target.model.default_thinking_tier,
    onAddCustom: data.onAddCustom,
    onDeleteCustom: data.onDeleteCustom,
  };
}

/**
 * 添加模型前的两条前置条件（spec 03 §6.1：连接必须 enabled 且有凭证），判据与后端
 * 写入侧的 `validateDeployable` 同源。
 *
 * 放在**提交前**拦，而不是等写入被拒后靠兜底文案解释：这两条一旦不成立，写入必然失败，
 * 用户重试多少次都一样，而兜底里那句「请重试」正是把人引向死循环的说明。两条各有一处
 * 可点的修复入口，所以提示要说清去哪修；弹层期间页面控件被遮罩挡住，必须写「关掉这个窗口后」。
 *
 * 已停用分两种：`disabled` 有「启用」按钮可点，入口保留、提交前拦下指路；`retired` 的添加入口
 * 与动作排都不渲染（spec §7.5：不提供必然失败的入口，也不解释为什么没有），这里的 retired 分支
 * 只是防御——拦的是拿旧连接对象直接调用的路径。
 */
const attachBlockedReason = (connection: ProviderConnection): string | null => {
  if (connection.lifecycle === 'disabled') {
    return `「${connection.display_name}」已停用。关掉这个窗口后点「启用」，再回来添加模型。`;
  }
  if (connection.lifecycle === 'retired') {
    return `「${connection.display_name}」已停用，加不了模型。`;
  }
  if (!connection.has_credential) {
    return `「${connection.display_name}」还没插密钥。关掉这个窗口后点「插入密钥」，再回来添加模型。`;
  }
  return null;
};

/**
 * 改一条已接入接入的配置（能力值、思考档位、「服务商那边的模型名」）受同一组前置条件约束：
 * 后端保存接入时同样要求连接 enabled 且有凭证（deployment-store 的 `validateDeployable`），
 * 不满足时保存必然失败，所以与接入一样在提交前拦下、指认可点的修复入口。
 *
 * retired 的行内「修改」与「模型 ID」输入框根本不渲染（spec §7.5：不提供必然失败的入口），
 * 这里只作防御；disabled 的入口保留——停用可恢复，「启用」按钮就在同一屏。
 */
const configWriteBlockedReason = (connection: ProviderConnection | null): string | null => {
  if (connection === null) return null;
  if (connection.lifecycle === 'disabled') {
    return `「${connection.display_name}」已停用。关掉这个窗口后点「启用」，再回来改配置。`;
  }
  if (connection.lifecycle === 'retired') {
    return `「${connection.display_name}」已停用，改不了配置。`;
  }
  if (!connection.has_credential) {
    return `「${connection.display_name}」还没插密钥。关掉这个窗口后点「插入密钥」，再回来改配置。`;
  }
  return null;
};

export function ProviderSection() {
  const {
    api,
    connections,
    deployments,
    activeRoutes,
    deploymentCountByConnection,
    catalog,
    chatCatalog,
    catalogUnavailable,
    thinkingTierPool,
    thinkingTierPoolUnavailable,
    customChatModels,
    customChatModelsUnavailable,
    customGenerationModels,
    agentDefaultModelId,
    saveAgentDefaultModel,
    generationDefaultModelId,
    saveGenerationDefaultModel,
    notice,
    setNotice,
    reload,
  } = useProviderData();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProviderConnection | null>(null);
  const [credentialFor, setCredentialFor] = useState<ProviderConnection | null>(null);
  const [addModelTo, setAddModelTo] = useState<ProviderConnection | null>(null);
  const [customModelTarget, setCustomModelTarget] = useState<CustomModelTarget>(null);
  const [confirm, setConfirm] = useState<ConfirmTarget>(null);
  /**
   * 自建模型弹层里的失败提示。
   *
   * 分区顶部的提示条在弹层期间被遮罩挡住，而保存、删除模型、加档位这些写入都是从弹层里发起的：
   * 失败原因必须出现在弹层里，否则用户点了没反应、也读不到为什么。与页面级 `notice` 分开是刻意的——
   * `notice` 带着上一次操作的结论，不该被搬进一个新打开的弹层。
   */
  const [dialogFailure, setDialogFailure] = useState<string | null>(null);

  const selected = selectedId === null ? null : connections.find((item) => item.connection_id === selectedId) ?? null;

  /** 选中的服务商被删掉后回落到第一条，避免右侧停在空态 */
  useEffect(() => {
    if (selectedId !== null && selected === null && connections.length > 0) {
      setSelectedId(connections[0]?.connection_id ?? null);
    }
  }, [connections, selected, selectedId]);

  // 进度行与详情行状态共用可执行目录（自带包模型与自建生成模型的族模板合成投影）。
  // 连接级接口类型已摘除（2026-09-29）：不再按连接协议在两个目录间选源——
  // 详情的行状态按行类型选目录（见 ProviderDetail），对话目录只服务对话行。
  const notReady = catalog.filter((entry) => !entry.deployment.deployable).length;
  const usableCount = catalog.length - notReady;
  // 每个服务商名下的自建模型数（对话与生成两族记录都按归属连接计数）：
  // 服务商卡片的「已添加 N 个模型」与删除影响面文案用它，跟接入数合并成同一个数。
  const customCountByConnection = new Map<string, number>();
  for (const record of [...customChatModels, ...customGenerationModels]) {
    customCountByConnection.set(
      record.connection_id,
      (customCountByConnection.get(record.connection_id) ?? 0) + 1,
    );
  }
  const modelCountByConnection = (connectionId: string): number =>
    (deploymentCountByConnection.get(connectionId) ?? 0) + (customCountByConnection.get(connectionId) ?? 0);

  /**
   * 跑一次写入并把结果交给调用方：`failure === null` 表示成功。
   *
   * 调用方需要据此决定后续 UI——删除成功后关掉正开着的那条弹层，失败把原因写进弹层
   * （从弹层发起的写入，原因不能只发到页面顶部那条被遮罩挡住的提示条上）。
   *
   * `notFoundText` 是「对象已经不在了」这一种失败的说明（见 describeError）：它与瞬时失败
   * 相反，重试永远不会成功，所以不能并用那句「请重试」。不传则仍回落到 fallback。
   */
  const run = async (
    action: () => Promise<void>,
    successText: string,
    fallback: string,
    notFoundText?: string,
  ): Promise<{ failure: string | null }> => {
    try {
      await action();
      setNotice({ tone: 'success', text: successText });
      await reload();
      return { failure: null };
    } catch (error: unknown) {
      const text = describeError(error, fallback, notFoundText);
      setNotice({ tone: 'error', text });
      return { failure: text };
    }
  };

  const {
    generationCustomFormFor,
    openEditGenerationModel,
    requestDeleteGenerationModel,
    confirmDeleteGenerationModel,
    generationModelEditDialog,
  } = useGenerationModelManagement({
    api,
    customGenerationModels,
    dialogFailure,
    reload,
    setNotice,
    setDialogFailure,
    setConfirm,
    run,
    attachBlockedReason,
  });

  const addProvider = async (payload: ProviderFormPayload): Promise<void> => {
    try {
      const created = await api.createProviderConnection({
        display_name: payload.display_name,
        base_url: payload.base_url,
      });
      setAdding(false);
      setSelectedId(created.connection.connection_id);
      if (payload.credential !== undefined && payload.credential !== '') {
        try {
          await api.setProviderConnectionCredential(created.connection.connection_id, payload.credential);
          setNotice({ tone: 'success', text: `已添加「${payload.display_name}」` });
        } catch (error: unknown) {
          setNotice({
            tone: 'warn',
            text: describeError(error, `「${payload.display_name}」已添加，密钥没写进去，请重新插入密钥`),
          });
        }
      } else {
        setNotice({ tone: 'success', text: `已添加「${payload.display_name}」` });
      }
      await reload();
    } catch (error: unknown) {
      const text = describeError(error, '没能添加服务商，请检查服务地址后重试');
      // 弹层保持打开：失败原因必须写进弹层（页面提示条被遮罩挡住，用户会看到「点了没反应」）
      setNotice({ tone: 'error', text });
      setDialogFailure(text);
    }
  };

  const addModels = async (connection: ProviderConnection, items: ModelMappingDraft[]): Promise<void> => {
    const blocked = attachBlockedReason(connection);
    if (blocked !== null) {
      setNotice({ tone: 'error', text: blocked });
      setDialogFailure(blocked);
      return;
    }
    try {
      for (const item of items) {
        const created = await api.createModelDeployment({
          connection_id: connection.connection_id,
          model_id: item.model_id,
          remote_model_id: item.remote_model_id,
        });
        await api.setActiveRoute(item.model_id, created.deployment.deployment_id);
      }
      setAddModelTo(null);
      setNotice({ tone: 'success', text: `已添加 ${items.length} 个模型` });
      setDialogFailure(null);
      await reload();
    } catch (error: unknown) {
      const text = describeError(
        error,
        // 输入侧已拦下「连接停用 / 没有密钥」，候选里也滤掉了已添加的模型；剩下只有写入侧会拒的理由
        // 「不支持」沿用行内状态徽章同一个词（见 invalidity.ts）：同一屏同一条件不该两套说法
        '没能添加这个模型，请重试；这个服务商不支持它，或它已经添加过了',
        '这个服务商已经不在了。关掉这个窗口后点「刷新」，就能看到最新状态。',
      );
      // 失败也要把列表刷回后端真实状态：批量添加中断时前面几条已经加上了，不刷新的话
      // 候选里还留着它们，用户再点一次必然撞上「已经添加过了」——同一句提示永远失败
      await reload();
      setNotice({ tone: 'error', text });
      setDialogFailure(text);
    }
  };

  /**
   * 加一个自定义档位进池（档位字段里的「添加档位」）。
   *
   * 「添加模型」与「修改」两个弹层共用本动作——两处是同一个写入（同一份池子），
   * 各写一份会让两处的失败提示与重试口径分叉。
   */
  const addThinkingTier = async (name: string): Promise<boolean> => {
    try {
      await api.addThinkingTier(name);
      setNotice({ tone: 'success', text: `已添加档位「${name}」` });
      setDialogFailure(null);
      await reload();
      return true;
    } catch (error: unknown) {
      const text = describeError(
        error,
        // 名称形状已在输入侧拦下（见 ThinkingTierFields），这里剩下的是重名、数量上限与瞬时失败
        `没能添加档位，请重试；档位名不能和已有档位重名，自定义档位最多 ${CUSTOM_THINKING_TIER_LIMIT} 个`,
      );
      setNotice({ tone: 'error', text });
      setDialogFailure(text);
      return false;
    }
  };

  /**
   * 添加对话模型（spec 03 §6.1「记录即接入」）：一次写入创建自建对话模型记录——
   * 接口类型、能力值、思考档位与接入归属（`connection_id`）同一次落库，active 接入由后端
   * 在创建内完成。接口类型随表单选择落库（2026-09-26 起协议归属模型级），不从连接继承。
   *
   * `model_id` 全局唯一：最常见的重名（已经添加到这个服务商）在提交前按本连接记录查重拦下；
   * 其余重名（已装模型、另一条连接下的记录、生成族命名空间）由后端 409 兜底，
   * 前端给「换个名字」的可读提示，不落进「请重试」死循环。
   */
  const addCustomModel = async (
    connection: ProviderConnection,
    payload: CustomModelDialogPayload,
  ): Promise<boolean> => {
    const blocked = attachBlockedReason(connection);
    if (blocked !== null) {
      setNotice({ tone: 'error', text: blocked });
      setDialogFailure(blocked);
      return false;
    }
    // 已经添加到这个服务商：用户的目标已经达成，写入只会撞上重名。
    // 在提交前说清，别让他对着一句「请重试」反复点（重试永远失败）
    const alreadyHere = customChatModels.some(
      (item) => item.connection_id === connection.connection_id && item.model_id === payload.modelId,
    );
    if (alreadyHere) {
      const text = `「${payload.modelId}」已经添加到这个服务商了。想改它，关掉这个窗口后在列表里点「修改」。`;
      setNotice({ tone: 'error', text });
      setDialogFailure(text);
      return false;
    }
    // 接口类型在创建表单里必选（空态起步，选了才能提交）；null 只出现在修改入口，
    // 那里不走本函数。真为 null 说明装配断了，留痕后放弃——不发没有协议声明的创建请求。
    if (payload.protocolAdapterId === null) {
      console.debug('[provider-connection] 创建对话模型缺少接口类型，放弃提交', payload.modelId);
      const text = '没能添加模型，请重试';
      setNotice({ tone: 'error', text });
      setDialogFailure(text);
      return false;
    }
    try {
      await api.createCustomChatModel({
        model_id: payload.modelId,
        connection_id: connection.connection_id,
        protocol_adapter_id: payload.protocolAdapterId,
        context_window_tokens: payload.contextWindowTokens,
        max_output_tokens: payload.maxOutputTokens,
        // 档位随创建一次落库（spec 37 创建写入路径）：勾了档位才携带两字段（档位与默认是
        // 同一次决定）；未勾（或本次没有档位上下文）时省略——契约语义下省略即空档位与无默认
        ...(payload.enabledThinkingTiers !== null && payload.enabledThinkingTiers.length > 0
          ? {
              enabled_thinking_tiers: payload.enabledThinkingTiers,
              default_thinking_tier: payload.defaultThinkingTier,
            }
          : {}),
      });
    } catch (error: unknown) {
      const text = isConflictError(error)
        ? `「${payload.modelId}」这个名字已经有模型在用了，换一个模型 ID 再添加。`
        : describeError(
            error,
            '没能添加模型，请重试；模型 ID 不能和已有的模型重复，也可能这个服务商不支持它',
            '这个服务商已经不在了。关掉这个窗口后点「刷新」，就能看到最新状态。',
          );
      setNotice({ tone: 'error', text });
      setDialogFailure(text);
      return false;
    }
    setNotice({ tone: 'success', text: `已添加「${payload.modelId}」` });
    setDialogFailure(null);
    await reload();
    return true;
  };

  /**
   * 保存一个自建对话模型记录的配置（服务商详情里该模型行的「修改」）。
   *
   * 修改接口是四字段整体替换（能力两字段 + 档位两字段，contracts 的 UpdateBodySchema 钉死）：
   * 顺序、成员与默认档位是同一次决定，能力与档位也是同一次提交。本次表单没带档位上下文
   * （记录归属的连接读不到）时，回写记录现有档位——等价于「档位这次不改」。
   */
  const updateChatModelConfig = async (
    record: CustomChatModel,
    payload: CustomModelDialogPayload,
  ): Promise<boolean> => {
    const blocker = configWriteBlockedReason(
      connections.find((item) => item.connection_id === record.connection_id) ?? null,
    );
    if (blocker !== null) {
      setNotice({ tone: 'error', text: blocker });
      setDialogFailure(blocker);
      return false;
    }
    try {
      await api.updateCustomChatModel(payload.modelId, {
        context_window_tokens: payload.contextWindowTokens,
        max_output_tokens: payload.maxOutputTokens,
        ...(payload.enabledThinkingTiers === null
          ? {
              enabled_thinking_tiers: record.enabled_thinking_tiers,
              default_thinking_tier: record.default_thinking_tier,
            }
          : {
              enabled_thinking_tiers: payload.enabledThinkingTiers,
              default_thinking_tier: payload.defaultThinkingTier,
            }),
      });
      setNotice({ tone: 'success', text: `已保存「${payload.modelId}」的模型配置` });
      setDialogFailure(null);
      await reload();
      return true;
    } catch (error: unknown) {
      const text = describeError(
        error,
        '没能保存模型配置，请重试',
        '这个模型已经不在了。关掉这个窗口后点「刷新」，就能看到最新状态。',
      );
      setNotice({ tone: 'error', text });
      setDialogFailure(text);
      return false;
    }
  };

  /**
   * 把某个已接入模型设为 Agent 形态的默认模型（spec docs/agent/06「agent 形态的输入面」）。
   *
   * 默认模型是**本机配置**（`config.agentDefaultModelId`），不是模型属性：同一时刻只有一个默认，
   * 设新的即替换旧的；已在默认位上的模型再点一次即取消默认。
   */
  const toggleAgentDefaultModel = async (modelId: string): Promise<void> => {
    const next = agentDefaultModelId === modelId ? null : modelId;
    try {
      await saveAgentDefaultModel(next);
      setNotice({
        tone: 'success',
        text: next === null ? `已取消「${modelId}」的 Agent 默认模型` : `已把「${modelId}」设为 Agent 默认模型`,
      });
    } catch (error: unknown) {
      setNotice({ tone: 'error', text: describeError(error, '没能保存 Agent 默认模型，请重试') });
    }
  };

  /**
   * 把某个已接入模型设为生成形态的默认模型（spec docs/hub/hub-information-architecture.md §7.4）。
   *
   * 与 Agent 默认同构，只是作用于另一种形态：同一时刻只有一个生成默认，设新的即替换旧的；
   * 已在默认位上的模型再点一次即取消默认。两条配置互不影响——设生成默认不改 Agent 默认，反之亦然。
   */
  const toggleGenerationDefaultModel = async (modelId: string): Promise<void> => {
    const next = generationDefaultModelId === modelId ? null : modelId;
    try {
      await saveGenerationDefaultModel(next);
      setNotice({
        tone: 'success',
        text: next === null ? `已取消「${modelId}」的生成默认模型` : `已把「${modelId}」设为生成默认模型`,
      });
    } catch (error: unknown) {
      setNotice({ tone: 'error', text: describeError(error, '没能保存生成默认模型，请重试') });
    }
  };

  /** 打开自建模型弹层：顺手清掉上一次留在弹层里的失败提示——新一次交互从干净状态开始 */
  const openCustomModelDialog = (target: NonNullable<CustomModelTarget>): void => {
    setDialogFailure(null);
    setCustomModelTarget(target);
  };

  /** 打开「添加模型」合并弹窗，同上：失败提示不跨交互沿用 */
  const openAddModelDialog = (connection: ProviderConnection): void => {
    setDialogFailure(null);
    setAddModelTo(connection);
  };

  /** 打开添加服务商弹层，同上：失败提示不跨交互沿用 */
  const openAddProvider = (): void => {
    setDialogFailure(null);
    setAdding(true);
  };

  /**
   * 打开自建对话模型行的「修改」：行由模型记录渲染（记录即接入），入口直接带着记录开弹层。
   * 旧路径里「声明读不到 / 清单没读到」两种防御不再需要——能渲染出这一行，记录就在数据源里。
   */
  const openChatModelConfig = (record: CustomChatModel): void => {
    openCustomModelDialog({ kind: 'edit', model: record });
  };

  /**
   * 删除一个自建模型（模型配置弹层里的「删除模型」）：删的是记录本身，它的 active 接入与
   * 「当前使用」标记由后端级联清理。影响面只有「模型本身消失」一种（记录归属创建它的连接，
   * 删除后只有那个服务商失去它），确认文案据此说明。
   */
  const requestDeleteModel = (modelId: string): void => {
    setConfirm({ kind: 'delete-custom-model', modelId });
  };

  /**
   * 删除一个自定义档位（档位字段「可添加」里的删除）：从全局池摘掉，正在用它的模型会失去它，
   * 所以先确认影响面。档位普通（内置常用档）只读，调用方只在自定义档位上调这里。
   */
  const requestDeleteThinkingTier = (name: string): void => {
    const usedByModels = thinkingTierPool.custom.find((item) => item.name === name)?.used_by_models ?? 0;
    setConfirm({ kind: 'delete-thinking-tier', name, usedByModels });
  };

  const dialogThinking = thinkingContextFor(customModelTarget, {
    connections,
    pool: thinkingTierPool,
    poolUnavailable: thinkingTierPoolUnavailable,
    onAddCustom: addThinkingTier,
    onDeleteCustom: requestDeleteThinkingTier,
  });

  const handleConfirm = async (confirmed: boolean): Promise<void> => {
    const target = confirm;
    setConfirm(null);
    if (!confirmed || target === null) return;
    if (target.kind === 'delete-provider') {
      const connectionId = target.connection.connection_id;
      // 影响面按来源分开说（后端级联见 provider-connection-routes DELETE，spec 03 §5.3）：
      // 在这里添加的自建模型记录被级联删除（模型本身消失）；
      // 软件自带的模型只是摘掉这条接入，模型本体仍在自带目录、之后可添加到其他服务商——不是「没了」
      const installed = deploymentCountByConnection.get(connectionId) ?? 0;
      const custom = customCountByConnection.get(connectionId) ?? 0;
      await run(
        () => api.deleteProviderConnection(connectionId).then(() => undefined),
        `已删除「${target.connection.display_name}」`
          + `${installed > 0 ? `，软件自带的 ${installed} 个模型之后可添加到其他服务商` : ''}`
          + `${custom > 0 ? `，在这里添加的 ${custom} 个模型已一并删除` : ''}`,
        '删除服务商失败，若有任务正在使用它，等任务跑完再试',
        `「${target.connection.display_name}」已经不在了，点「刷新」看最新状态`,
      );
      return;
    }
    if (target.kind === 'clear-credential') {
      // 删密钥不删任何记录：已装模型的接入与自建模型记录都还在，只是都不可用了——合并成一个数
      const affected = modelCountByConnection(target.connection.connection_id);
      await run(
        () => api.removeProviderConnectionCredential(target.connection.connection_id).then(() => undefined),
        `已删除「${target.connection.display_name}」的密钥${affected > 0 ? `，${affected} 个模型变为不可用` : ''}`,
        '没能删除密钥，请重试',
        `「${target.connection.display_name}」已经不在了，点「刷新」看最新状态`,
      );
      return;
    }
    if (target.kind === 'delete-thinking-tier') {
      const { failure } = await run(
        () => api.removeThinkingTier(target.name).then(() => undefined),
        `已删除档位「${target.name}」${target.usedByModels > 0 ? `，${target.usedByModels} 个模型不再有它` : ''}`,
        '没能删除档位，请重试',
        // 弹层里点不到被遮罩挡住的「刷新」：说明要写成「关掉这个窗口后」，
        // 且不能只说「关掉重开」——关掉弹层本身不会重新装载数据，那是句兑现不了的承诺
        '这个档位已经不在了。关掉这个窗口后点「刷新」，就能看到最新状态。',
      );
      // 入口在模型配置弹层里：原因也留在那里（成功则清掉上一次的）
      setDialogFailure(failure);
      return;
    }
    if (target.kind === 'delete-custom-model') {
      const { failure } = await run(
        () => api.deleteCustomChatModel(target.modelId).then(() => undefined),
        `已删除模型「${target.modelId}」`,
        '没能删除模型，请重试',
        '这个模型已经不在了。关掉这个窗口后点「刷新」，就能看到最新状态。',
      );
      setDialogFailure(failure);
      // 删成的正是配置弹层里那个模型：关掉弹层（它已经没有对应的行）；
      // 没删成则留着——用户填的内容还在，原因已经写进弹层里
      if (failure === null) setCustomModelTarget(null);
      return;
    }
    if (target.kind === 'delete-custom-generation-model') {
      await confirmDeleteGenerationModel(target);
      return;
    }
    await run(
      () => api.deleteModelDeployment(target.deploymentId).then(() => undefined),
      `已移除模型「${target.modelId}」`,
      '没能移除模型，请重试',
      `「${target.modelId}」已经不在列表里了，点「刷新」看最新状态`,
    );
  };

  return (
    <SettingsSection
      title="服务商"
      action={<Button size="sm" variant="outline" onClick={() => void reload()}>刷新</Button>}
    >
      <div className="flex flex-col gap-3">
        <ProviderNoticeBar notice={notice} onDismiss={() => setNotice(null)} />

        {catalogUnavailable ? (
          <p className="text-xs text-muted-foreground">暂时读不到模型清单，点「刷新」再试。</p>
        ) : null}

        {connections.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border px-4 py-10 text-center">
            <Server className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">还没有服务商</p>
            <Button size="sm" onClick={openAddProvider}>添加服务商</Button>
          </div>
        ) : (
          <>
            {/* 进度行只读报数（设计文档裁定：快捷按钮随多选弹层退役，添加走详情里唯一的「添加模型」）。
                N = 软件自带的模型总数（可执行目录条目），M = 这里当前可用的个数（部署判定通过）。
                目录恒用可执行目录（连接级接口类型已摘除，不再按连接协议分流）。 */}
            {catalog.length > 0 ? (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                软件自带 {catalog.length} 个模型，当前可用 {usableCount} 个
              </div>
            ) : null}

            {/* 主从分栏（docs/hub/hub-information-architecture.md §7.2 版式定案 + visual-design §8.5）：
                左列服务商列表定宽 240px（w-60），右列详情自适应、顶对齐；面板高度由内容决定
                （min-h-[420px] 已退役），不设滚动容器——内容定高后 overflow-y-auto 是永不触发的死滚动。 */}
            <div className="flex overflow-hidden rounded-md border border-border">
              <div className="flex w-60 shrink-0 flex-col gap-2 border-r border-border bg-muted/40 p-3">
                <Button size="sm" onClick={openAddProvider}>＋ 添加服务商</Button>
                {connections.map((connection) => (
                  <ProviderCard
                    key={connection.connection_id}
                    connection={connection}
                    modelCount={modelCountByConnection(connection.connection_id)}
                    selected={connection.connection_id === selectedId}
                    onSelect={() => setSelectedId(connection.connection_id)}
                  />
                ))}
              </div>

              <div className="min-w-0 flex-1 p-4">
                {selected === null ? (
                  <p className="py-8 text-center text-xs text-muted-foreground">左边选一个服务商看详情</p>
                ) : (
                  <ProviderDetail
                    connection={selected}
                    catalog={catalog}
                    chatCatalog={chatCatalog}
                    deployments={deployments.filter((item) => item.connection_id === selected.connection_id)}
                    customChatModels={customChatModels.filter((item) => item.connection_id === selected.connection_id)}
                    modelListUnavailable={catalogUnavailable || customChatModelsUnavailable}
                    customGenerationModels={customGenerationModels.filter(
                      (item) => item.connection_id === selected.connection_id,
                    )}
                    activeRoutes={activeRoutes}
                    onEdit={() => setEditing(selected)}
                    onCredential={() => setCredentialFor(selected)}
                    onToggle={() => {
                      const next = selected.lifecycle === 'enabled' ? 'disabled' : 'enabled';
                      void run(
                        () => api.setProviderConnectionLifecycle(selected.connection_id, next).then(() => undefined),
                        `已${next === 'enabled' ? '启用' : '停用'}「${selected.display_name}」`,
                        '没能更新状态，请重试',
                        `「${selected.display_name}」已经不在了，点「刷新」看最新状态`,
                      );
                    }}
                    onClearCredential={() => setConfirm({ kind: 'clear-credential', connection: selected })}
                    onDelete={() => setConfirm({ kind: 'delete-provider', connection: selected })}
                    onAddModelByKind={(kind) => {
                      // 二级选择的结果（添加模型的唯一入口，见 ProviderDetail）：
                      // 生成侧开合并弹窗（自带模型勾选 + 自定义表单），对话侧开自建表单弹层
                      if (kind === 'chat') {
                        openCustomModelDialog({ kind: 'create', connection: selected });
                        return;
                      }
                      openAddModelDialog(selected);
                    }}
                    onRenameModel={(deploymentId, modelId, remoteModelId) => {
                      // 「服务商那边的模型名」是这条接入的一部分，保存受同一组前置条件约束
                      const blocker = configWriteBlockedReason(selected);
                      if (blocker !== null) {
                        setNotice({ tone: 'error', text: blocker });
                        return;
                      }
                      void run(
                        () => api.updateModelDeployment(deploymentId, { remote_model_id: remoteModelId }).then(() => undefined),
                        `已更新「${modelId}」的服务商那边的模型 ID`,
                        '没能保存服务商那边的模型 ID，请重试',
                        `「${modelId}」已经不在列表里了，点「刷新」看最新状态`,
                      );
                    }}
                    onRemoveModel={(deploymentId, modelId) => setConfirm({ kind: 'remove-model', deploymentId, modelId })}
                    onEditChatModel={openChatModelConfig}
                    agentDefaultModelId={agentDefaultModelId}
                    onToggleAgentDefault={(modelId) => void toggleAgentDefaultModel(modelId)}
                    generationDefaultModelId={generationDefaultModelId}
                    onToggleGenerationDefault={(modelId) => void toggleGenerationDefaultModel(modelId)}
                    onDeleteGenerationModel={requestDeleteGenerationModel}
                    onEditGenerationModel={openEditGenerationModel}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirmTitle(confirm)}
        message={confirmMessage(confirm, deploymentCountByConnection, customCountByConnection)}
        confirmLabel={confirm?.kind === 'remove-model' ? '移除' : '删除'}
        danger
        onResolve={(value) => void handleConfirm(value)}
      />

      {adding ? (
        <ProviderFormDialog
          // 创建态的重复地址提示（非阻断）：与已有服务商同址时提醒确认
          existingBaseUrls={connections.map((connection) => connection.base_url)}
          // 添加失败时弹层保持打开，原因显示在这里：页面提示条被遮罩挡住，用户会看到「点了没反应」
          failureText={dialogFailure}
          onClose={() => setAdding(false)}
          onSubmit={addProvider}
        />
      ) : null}

      {editing !== null ? (
        <ProviderFormDialog
          connection={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (payload) => {
            await run(
              () =>
                api
                  .updateProviderConnection(editing.connection_id, {
                    display_name: payload.display_name,
                    base_url: payload.base_url,
                  })
                  .then(() => undefined),
              `已更新「${payload.display_name}」`,
              '没能保存，请重试',
            );
            setEditing(null);
          }}
        />
      ) : null}

      {credentialFor !== null ? (
        <CredentialDialog
          providerName={credentialFor.display_name}
          hasCredential={credentialFor.has_credential}
          onClose={() => setCredentialFor(null)}
          onSubmit={async (value) => {
            await run(
              () => api.setProviderConnectionCredential(credentialFor.connection_id, value).then(() => undefined),
              `已更新「${credentialFor.display_name}」的密钥`,
              '没能保存密钥，请重试',
            );
            setCredentialFor(null);
          }}
        />
      ) : null}

      {addModelTo !== null ? (
        <AddModelDialog
          providerName={addModelTo.display_name}
          catalog={catalog}
          catalogUnavailable={catalogUnavailable}
          boundModelIds={new Set(
            deployments.filter((item) => item.connection_id === addModelTo.connection_id).map((item) => item.model_id),
          )}
          // 「自定义接口的模型」区块随每条连接的生成侧入口装配（协议归属模型级，
          // 记录自带接口类型声明，不再按连接协议设限，见 useGenerationModelManagement）
          customForm={generationCustomFormFor(addModelTo)}
          failureText={dialogFailure}
          onClose={() => {
            // 关掉弹层即清掉它自己的失败提示，下一次打开是干净的一次交互
            setDialogFailure(null);
            setAddModelTo(null);
          }}
          onSubmitBuiltIn={(items) => addModels(addModelTo, items)}
        />
      ) : null}

      {customModelTarget !== null ? (
        <CustomModelDialog
          mode={
            customModelTarget.kind === 'create'
              ? { kind: 'create', providerName: customModelTarget.connection.display_name }
              : { kind: 'edit', model: customModelTarget.model }
          }
          thinking={dialogThinking}
          // 弹层里的写入失败把原因显示在这里：分区顶部的提示条被遮罩挡住，用户看不到
          failureText={dialogFailure}
          // 删除只随「改模型配置」出现：模型行内没有删除入口，删除放在模型自己的配置弹层里
          // （行内的「移除」只摘已装包模型的接入，自建模型没有这一层）
          {...(customModelTarget.kind === 'edit'
            ? { onDelete: () => requestDeleteModel(customModelTarget.model.model_id) }
            : {})}
          onClose={() => {
            // 关掉弹层即清掉它自己的失败提示，下一次打开是干净的一次交互
            setDialogFailure(null);
            setCustomModelTarget(null);
          }}
          onSubmit={(payload) => {
            if (customModelTarget.kind === 'create') return addCustomModel(customModelTarget.connection, payload);
            return updateChatModelConfig(customModelTarget.model, payload);
          }}
        />
      ) : null}

      {generationModelEditDialog}
    </SettingsSection>
  );
}

function ProviderCard({
  connection,
  modelCount,
  selected,
  onSelect,
}: {
  connection: ProviderConnection;
  modelCount: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone: BindingTone = connection.lifecycle !== 'enabled'
    ? 'bad'
    : connection.has_credential
      ? 'ok'
      : 'warn';
  const status = connection.lifecycle !== 'enabled'
    ? '已停用'
    : connection.has_credential
      ? '已启用'
      : '缺少密钥';

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className={
        'flex cursor-pointer flex-col gap-1 rounded-md bg-elevated px-3 py-2 transition-colors '
        + (selected ? 'ring-1 ring-primary' : 'hover:bg-primary/5')
      }
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{connection.display_name}</span>
        {/* StatusPill 不收 className（归 ProviderNoticeBar.tsx），shrink-0 由外层包裹承担；
            leading-none 压掉包裹 span 自身继承的 16px/24px 行盒（否则行 1 被空行盒撑到 ~24.5px，
            徽章本体只有 ~20px），行高回落到徽章本体 */}
        <span className="shrink-0 leading-none">
          <StatusPill tone={tone} label={status} />
        </span>
      </div>
      {/* 行 2 元信息：URL 过长被截断（title 兜底全文），「已添加 N 个模型」摘要恒可见
          （docs/hub/hub-information-architecture.md §7.2：摘要是列表扫描时的计数信息，保留） */}
      <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={connection.base_url}>{connection.base_url}</span>
        <span className="shrink-0">已添加 {modelCount} 个模型</span>
      </div>
    </div>
  );
}

