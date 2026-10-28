import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ActiveRouteMap,
  CustomChatModel,
  CustomGenerationModel,
  ExecutableModelDirectoryEntry,
  InterfaceRecipe,
  ProviderConnection,
  ThinkingTierPool,
} from '@iart/contracts';
import { buildConfigUpdatePayload } from '../../../client/settings/config-update';
import { HubHttpError } from '../../../client/adapters/http-client';
import { useHubRuntime } from '../../../components/providers/HubAppProvider';
import { countModelsByConnection } from './invalidity';

/**
 * 「服务商与模型」分区的唯一数据源。
 *
 * 口径对齐 `docs/custom-providers/provider-config-ui-design.md`：
 * - **单一实例**：服务商列表、详情与各弹窗共享本 context 的一次装载，避免双份请求
 *   与状态不同步（在 A 处停用一个服务商后，B 处仍按旧值渲染可选服务与失效原因）。
 * - **提示与数据分离**：`reload()` 只刷新数据，不清空提示。若 `reload()` 末尾清空状态，
 *   会把刚写入的成功提示抹掉（成功提示 0 帧可见），错误提示也会被同样抹掉、
 *   表现为"点了没反应"。提示由调用方通过 `notice` 显式设置与清除。
 * - **目录失败要可见**：目录端点失败时不再静默给空数组，而是暴露 `catalogUnavailable`，
 *   由界面区分「读不到目录」与「没有可接入模型」。
 * - **目录按协议族分流**：可执行目录（`catalog`，含自建生成模型的族模板合成投影）与对话模型目录
 *   （`chatCatalog`）是两个独立端点：对话模型不进 PromptDock 目录。连接级接口格式已摘除
 *   （2026-09-29），消费方不再按连接协议选源——详情行状态按行类型选目录（见 ProviderDetail）。
 * - **模型记录单独取一次**：`customChatModels` / `customGenerationModels` 是用户自己添加的模型
 *   （能力属性 + 所属服务商一体），与目录不是同一件事——它属于「用户添加了什么」，目录属于
 *   「现在能用什么」，两者不能互相推导。2026-10-19 起它是模型**唯一**的来源，因此不再有与它
 *   并列的接入清单。
 * - **三态显式化**：`loadState` 区分「正在读取 / 读取失败 / 已就绪」。此前只有 `loading` 布尔
 *   且无消费方，界面用「还没有服务商」兜住了加载中与读取失败两种状态——用户读到的是
 *   「你还没配」，于是去重复创建（2026-10-19 修正）。
 * - **形态默认模型来自配置**：它们不是模型属性，而是「创作面进入某个形态时用哪个模型」这条本机配置
 *   （`config.agentDefaultModelId` / `config.generationDefaultModelId`，两者都是连接无关的本机偏好）；
 *   读写都留在本 hook，让「哪个模型是默认」在同一份装载里只有一个值。
 */

/** 用户可读提示；`tone` 决定呈现为成功 / 警告 / 失败三态之一 */
export interface ProviderNotice {
  tone: 'success' | 'warn' | 'error';
  text: string;
}

export function useProviderConnectionData() {
  const { api } = useHubRuntime();
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [activeRoutes, setActiveRoutes] = useState<ActiveRouteMap>({});
  const [catalog, setCatalog] = useState<ExecutableModelDirectoryEntry[]>([]);
  /** 对话模型目录（GET /api/chat-model-catalog） */
  const [chatCatalog, setChatCatalog] = useState<ExecutableModelDirectoryEntry[]>([]);
  /** 目录端点是否不可用（与「目录为空」区分） */
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  const [chatCatalogUnavailable, setChatCatalogUnavailable] = useState(false);
  /** 思考档位预设池（GET /api/thinking-tiers）：内置档 + 自定义档 */
  const [thinkingTierPool, setThinkingTierPool] = useState<ThinkingTierPool>({ builtin: [], custom: [] });
  const [thinkingTierPoolUnavailable, setThinkingTierPoolUnavailable] = useState(false);
  /** 用户自建对话模型（GET /api/custom-chat-models，spec 03 §6.1「记录即接入」） */
  const [customChatModels, setCustomChatModels] = useState<CustomChatModel[]>([]);
  const [customChatModelsUnavailable, setCustomChatModelsUnavailable] = useState(false);
  /** 用户自建生成模型（GET /api/custom-generation-models）：删除入口用它判「是不是自己添加的」 */
  const [customGenerationModels, setCustomGenerationModels] = useState<CustomGenerationModel[]>([]);
  const [customGenerationModelsUnavailable, setCustomGenerationModelsUnavailable] = useState(false);
  /** 接口配方公共库（GET /api/interface-recipes）：全局共享，模型记录按 recipe_id 引用 */
  const [interfaceRecipes, setInterfaceRecipes] = useState<InterfaceRecipe[]>([]);
  const [interfaceRecipesUnavailable, setInterfaceRecipesUnavailable] = useState(false);
  /** Agent 形态默认模型（GET /api/config 的 `agentDefaultModelId`）；null = 没设默认 */
  const [agentDefaultModelId, setAgentDefaultModelId] = useState<string | null>(null);
  /** 生成形态默认模型（GET /api/config 的 `generationDefaultModelId`）；null = 没设默认 */
  const [generationDefaultModelId, setGenerationDefaultModelId] = useState<string | null>(null);
  /**
   * 装载三态：`idle` 仅存在于首次装载发起前的一瞬，界面按「正在读取」处理。
   * 失败时保留 `loadError`，由页面渲染「没能读取 + 重试」，不再冒充空态。
   */
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ProviderNotice | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoadState('loading');
    try {
      // 协议适配器清单不再拉取（2026-09-29 摘除连接级预选后，Hub 无消费方；
      // 后端端点与客户端方法保留）。接口格式只在添加模型时配置，表单选项值域来自契约枚举。
      const [connectionResult, routeResult] = await Promise.all([
        api.listProviderConnections(undefined),
        api.listActiveRoutes(undefined),
      ]);
      setConnections(connectionResult.connections);
      setActiveRoutes(routeResult.active_routes);
      // 模型目录：契约字段来自 Runtime Backend 模型能力包投影，Hub 不得本地推导或伪造
      // （AGENTS.md：禁止复制 Provider 事实源）。可执行目录服务进度行与非对话行状态，
      // 对话目录服务对话行状态；端点不可用时显式标记，不静默降级为空。
      const [
        catalogOutcome,
        chatCatalogOutcome,
        tierPoolOutcome,
        customModelOutcome,
        customGenerationOutcome,
        recipeOutcome,
      ] = await Promise.allSettled([
        api.listExecutableModelCatalog(undefined),
        api.listChatModelCatalog(undefined),
        api.listThinkingTiers(undefined),
        api.listCustomChatModels(undefined),
        api.listCustomGenerationModels(undefined),
        api.listInterfaceRecipes(undefined),
      ]);
      if (catalogOutcome.status === 'fulfilled') {
        setCatalog(catalogOutcome.value.models);
        setCatalogUnavailable(false);
      } else {
        setCatalog([]);
        setCatalogUnavailable(true);
      }
      if (chatCatalogOutcome.status === 'fulfilled') {
        setChatCatalog(chatCatalogOutcome.value.models);
        setChatCatalogUnavailable(false);
      } else {
        setChatCatalog([]);
        setChatCatalogUnavailable(true);
      }
      if (tierPoolOutcome.status === 'fulfilled') {
        setThinkingTierPool(tierPoolOutcome.value.pool);
        setThinkingTierPoolUnavailable(false);
      } else {
        setThinkingTierPool({ builtin: [], custom: [] });
        setThinkingTierPoolUnavailable(true);
      }
      if (customModelOutcome.status === 'fulfilled') {
        setCustomChatModels(customModelOutcome.value.models);
        setCustomChatModelsUnavailable(false);
      } else {
        setCustomChatModels([]);
        setCustomChatModelsUnavailable(true);
      }
      if (customGenerationOutcome.status === 'fulfilled') {
        setCustomGenerationModels(customGenerationOutcome.value.models);
        setCustomGenerationModelsUnavailable(false);
      } else {
        setCustomGenerationModels([]);
        setCustomGenerationModelsUnavailable(true);
      }
      if (recipeOutcome.status === 'fulfilled') {
        setInterfaceRecipes(recipeOutcome.value.recipes);
        setInterfaceRecipesUnavailable(false);
      } else {
        setInterfaceRecipes([]);
        setInterfaceRecipesUnavailable(true);
      }
      // 默认模型：两种形态各一条本机配置，读不到就都按「没设默认」呈现——它们只影响创作面的
      // 初始预选，不是配置真相的展示面。两条配置来自同一次 GET /api/config，不为此多发一次请求。
      try {
        const config = await api.loadConfig(undefined);
        setAgentDefaultModelId(config.resolved.agentDefaultModelId);
        setGenerationDefaultModelId(config.resolved.generationDefaultModelId);
      } catch (error: unknown) {
        console.debug('[provider-connection] 读不到默认模型配置', error);
        setAgentDefaultModelId(null);
        setGenerationDefaultModelId(null);
      }
      setLoadState('ready');
      setLoadError(null);
    } catch (error: unknown) {
      // 读取失败只落到 loadState，**不再覆盖 notice**：notice 承载的是用户上一次写入的结论
      // （成功或失败），被一次后台重读的失败顶掉会让用户以为刚才那步没成功
      // （2026-10-19 修正；此前 reload 失败直接写 notice，与成功提示互相覆盖）。
      setLoadState('error');
      setLoadError(describeError(error, '没能读取服务商列表'));
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * 设置 / 取消 Agent 形态的默认模型（spec docs/agent/06「agent 形态的输入面」）。
   *
   * 传 null 表示取消默认（与「不改」在请求体上是两种写法）；成功后重新装载，让徽章与列表同步。
   */
  const saveAgentDefaultModel = useCallback(
    async (modelId: string | null): Promise<void> => {
      await api.saveConfig(buildConfigUpdatePayload({ agentDefaultModelId: modelId }));
      await reload();
    },
    [api, reload],
  );

  /**
   * 设置 / 取消生成形态的默认模型（spec docs/hub/hub-information-architecture.md §7.4）。
   *
   * 与 Agent 默认同构：传 null 表示取消默认（与「不改」在请求体上是两种写法），成功后重新装载。
   * 这里不校验这个模型在不在可执行目录里——对齐 `agentDefaultModelId` 的既有裁定（配置值不做存在性校验），
   * 目录里没有它时由创作面按「没设默认」回落，不在这里拦下用户。
   */
  const saveGenerationDefaultModel = useCallback(
    async (modelId: string | null): Promise<void> => {
      await api.saveConfig(buildConfigUpdatePayload({ generationDefaultModelId: modelId }));
      await reload();
    },
    [api, reload],
  );

  const connectionById = useMemo(
    () => new Map(connections.map((connection) => [connection.connection_id, connection])),
    [connections],
  );
  // 每个服务商名下有多少个模型：两族记录同属一种对象「模型」，计数合并成一个数。
  const modelCountByConnection = useMemo(
    () => countModelsByConnection([...customChatModels, ...customGenerationModels]),
    [customChatModels, customGenerationModels],
  );
  const activeRecordIds = useMemo(() => new Set(Object.values(activeRoutes)), [activeRoutes]);

  return {
    api,
    connections,
    activeRoutes,
    activeRecordIds,
    connectionById,
    modelCountByConnection,
    catalog,
    chatCatalog,
    catalogUnavailable,
    chatCatalogUnavailable,
    thinkingTierPool,
    thinkingTierPoolUnavailable,
    customChatModels,
    customChatModelsUnavailable,
    customGenerationModels,
    customGenerationModelsUnavailable,
    interfaceRecipes,
    interfaceRecipesUnavailable,
    agentDefaultModelId,
    saveAgentDefaultModel,
    generationDefaultModelId,
    saveGenerationDefaultModel,
    loadState,
    loadError,
    notice,
    setNotice,
    reload,
  };
}

/**
 * 把失败统一收敛成调用方给的行动句。
 *
 * 口径：内部异常原文（后端类名、字段名、状态码、`Failed to fetch` 这类浏览器原文）
 * 一律不上屏——用户读不懂，也无法据此自助修复，只会把排查工作推给他；更糟的是它还会
 * 顶掉调用方本已写好的中文提示。原文经 `console.debug` 进日志与「复制错误详情」链路，
 * 界面只拿调用方的 fallback。
 *
 * 因此本函数不做"短原文就放行"的启发式：按长度放行等于按运气守卫，
 * 实测能上屏的正是 `ProviderConnection 不存在`、`retired 连接不可绑定凭证` 这类内部串。
 *
 * 唯一的分类例外是 **404「对象已经不在了」**：它不是异常原文，而是一个用户自己能修的理由
 * （页面上的列表是旧的，重开或刷新就能看到真实状态），且与所有瞬时失败相反——
 * 重试永远不会成功。调用方给了 `notFoundText` 时按它说，让用户从「请重试」里出来。
 */
export function describeError(error: unknown, fallback: string, notFoundText?: string): string {
  console.debug('[provider-connection] 服务商配置请求失败', error);
  if (notFoundText !== undefined && error instanceof HubHttpError && error.status === 404) return notFoundText;
  return fallback;
}

/**
 * 写入撞上重名（HTTP 409）的判定：`model_id` 全局唯一由后端兜底，前端拿不到更细的原因码，
 * 但能确定「重试多少次都不会成功，改个名字就能过」——调用方据此给可读的冲突提示，
 * 不落进「请重试」死循环。
 */
export function isConflictError(error: unknown): boolean {
  return error instanceof HubHttpError && error.status === 409;
}

/**
 * 与 `describeError` 同构，唯一的差别：后端**确定性校验失败**返回的 message 原样透出。
 *
 * 写入侧的确定性拒绝（重名、命名空间护栏、族不匹配这类）是后端写给用户读的可操作原因
 * ——用户改个名字就能过；笼统化成「请重试」会把可修复的失败变成死循环（ui-copy-standard
 * 落地口径第 6 条的反向信号）。`HubHttpError` 携带的后端 message 由此上屏；没有 message
 * （`http-<status>` 合成串）、解析失败等内部异常仍走 fallback，内部原文不上屏。
 */
export function describeErrorWithReason(error: unknown, fallback: string, notFoundText?: string): string {
  console.debug('[provider-connection] 服务商配置请求失败', error);
  if (notFoundText !== undefined && error instanceof HubHttpError && error.status === 404) return notFoundText;
  if (error instanceof HubHttpError) {
    const message = error.message.trim();
    if (message !== '' && message !== `http-${error.status}`) return message;
  }
  return fallback;
}

export type ProviderConnectionData = ReturnType<typeof useProviderConnectionData>;
