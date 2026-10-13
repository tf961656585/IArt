/**
 * 文件作用：模型运行时配置入口
 * - 普通远端模型来自 Runtime Backend 下发的模型资产投影
 * - 本地 processor 节点来自 Editor 内建自动发现
 * - 通过 findModelConfig 等工具函数提供统一查询，不要求普通模型新增 Editor adapter
 * - 已知 Provider 展示元数据见 providers.config.ts；未知 Provider 可由 catalog 动态兜底
 */
import type { GenerationAdapter, TaskType } from '../adapters/types';
import type { ModelWorkspaceConfig } from '@/features/workspace/modelFormTypes';
import { discoverModels } from './modelAutoDiscovery';
import type { ProviderId } from './providers.config';
import type { CanonicalFieldKey } from '@/features/canvas/nodes/model/canonicalPorts';
import type { SchemaConditionExpression } from '@/features/workspace/schema/types';
import type { DynamicRecord } from '@/client/utils/typeGuards';

export type ModelMode = 'text' | 'image' | 'video';

/**
 * 模型角色类型
 * - generator: 生成模型，用于生成内容（用于生成模型列表与 Canvas 模型节点）
 * - processor: 处理节点，用于处理/转换数据（仅用于 Canvas）
 */
export type ModelRole = 'generator' | 'processor';

export interface ModelCopyLocalization {
  labelKey: string | undefined;
  descriptionKey: string | undefined;
}

export interface ModelAssetInputContract {
  promptFieldKey: string | undefined;
  /** 提示词字符上限，派生自投影顶层 `prompt_field.validation_rules` 的 max_length（方案 B）。 */
  promptMaxLength: number | undefined;
  requiredFieldKeys: string[] | undefined;
  imageInputFieldKeys: string[] | undefined;
}

/**
 * 模型调用历史缓存的基础结构
 * - input: 记录提交表单时的关键信息
 * - output: 记录模型返回的原始响应，便于复现或调试
 */
export interface ModelHistoryInputSnapshot {
  prompt: string;
  parameters: DynamicRecord;
  createdAt: string; // ISO 8601 时间戳，便于序列化到本地缓存
}

export interface ModelHistoryOutputSnapshot {
  rawResponse: unknown;
}

export interface ModelHistoryCacheEntry {
  modelId: string; // 对应的模型标识，便于按模型维度筛选历史记录
  input: ModelHistoryInputSnapshot;
  output: ModelHistoryOutputSnapshot | undefined; // 有些任务可能仍在处理中
}

export type ModelHistoryCache = ModelHistoryCacheEntry[];

/** 画板节点端口配置 */
export interface NodeGraphPortConfig {
  /** 端口 ID */
  id: string;
  /** 端口显示名称 */
  name: string;
  /** 端口数据类型 */
  dataType: 'text' | 'image' | 'video' | 'audio' | 'url' | 'any';
  /** 对应的表单字段 key */
  fieldKey: string;
  /** 对应的 canonical 字段（可选，用于跨节点对齐语义） */
  canonicalKey: CanonicalFieldKey | undefined;
  /** 端口描述 */
  description: string | undefined;
  /** 是否必需 */
  required: boolean | undefined;
  /** 是否允许多连接/多值 */
  multiple: boolean | undefined;
  /** 多连端口的最大连接数（未设置则不限制） */
  maxConnections: number | undefined;
  /**
   * 来自模型资产包的 data_source 声明。
   * 当值为 "connection" 或 "both" 时，该端口已由 Backend 推导确认，
   * Editor 端跳过白名单过滤，直接暴露为输入端口。
   */
  dataSource: 'connection' | 'form' | 'both' | undefined;
  /**
   * 端口可见性条件，来自模型资产包 input_port 的 visible_when 声明。
   * 求值结果决定端口 Handle 是否渲染（隐藏时端口对象仍保留，连线不丢失）。
   * 语义与表单字段 visibleWhen 对称。
   */
  visibleWhen: SchemaConditionExpression<string> | undefined;
}

export interface CanvasPortFieldSpec {
  /** 对应表单字段 key（实际存储字段） */
  fieldKey: string;
  /** 对应的 canonical 字段（用于校验/推导），可省略自动按 alias 解析 */
  canonicalKey: CanonicalFieldKey | undefined;
  /** 端口 ID 覆盖（默认使用 canonical portId） */
  portId: string | undefined;
  /** 端口数据类型覆盖（默认取 canonical） */
  dataType: NodeGraphPortConfig['dataType'] | undefined;
  /** 是否必填 */
  required: boolean | undefined;
  /** 是否允许多连/多值 */
  multiple: boolean | undefined;
  /** 端口描述 */
  description: string | undefined;
  /** 默认值（优先于 canonical 默认值） */
  defaultValue: unknown | undefined;
}

export interface CanvasPortSpec {
  inputs: CanvasPortFieldSpec[];
}

/**
 * 视频生成模式单项配置
 * - labelKey: i18n 翻译键
 * - color: 可选的状态颜色
 */
export interface VideoGenModeLabelConfig {
  labelKey: string;
  color: string | undefined;
}

/**
 * 视频生成模式配置
 * 用于在 Canvas 节点属性面板中显示当前视频生成模式（文生视频/首帧模式/首尾帧模式）
 */
export interface VideoGenModeConfig {
  /** 是否启用模式指示器 */
  enabled: true;
  /** 图片输入端口的 fieldKey（用于计算连接的图片数量） */
  imageFieldKey: string;
  /** 各模式配置，key 为图片数量 */
  modes: {
    /** 无图片输入：文生视频模式 */
    0: VideoGenModeLabelConfig;
    /** 1张图片：首帧模式 */
    1: VideoGenModeLabelConfig;
    /** 2张图片：首尾帧模式 */
    2: VideoGenModeLabelConfig;
  };
}

/** Canvas 节点属性面板的额外字段（仅在属性面板配置，不开放为输入端口） */
export interface CanvasInspectorSpec {
  /** 仅在节点属性面板展示的表单字段 key */
  properties: string[];
}

export interface ModelConfigEntry {
  providerId: ProviderId;      // AI 厂商标识（关联 providers.config.ts）
  /**
   * 可选：模型所属分组 ID（关联 modelGroups.config.ts）
   * - 未设置时默认使用 providerId
   * - 允许自定义分组（如跨 provider 的推荐模型）
   */
  groupId: string | undefined;
  label: string;               // UI 展示名称
  modelId: string;             // 正式模型身份，Runtime/投影主链统一以此为 canonical key
  defaultTaskType: TaskType;   // 默认任务类型
  mode: ModelMode;             // UI 默认模式（用于表单/节点的默认呈现）
  adapter: GenerationAdapter;  // 对应的适配器实例
  defaults: DynamicRecord | undefined; // 可选：请求默认值（endpoint/method/contentType/headers 等）
  visible: boolean | undefined;           // 可选：是否在模型选择器中可见（默认 true）
  role: ModelRole | undefined;            // 可选：模型角色（默认 generator）
  description: string | undefined;        // 可选：模型描述
  aliases: string[] | undefined;          // 可选：额外可用于查找的别名
  routeSegment: string | undefined;       // 可选：在路由中使用的 slug（默认等于 modelId）
  workspace: ModelWorkspaceConfig | undefined;
  /** 画板端口字段声明（无 nodeGraphPorts 时按此生成） */
  canvasPortSpec: CanvasPortSpec | undefined;
  i18n: ModelCopyLocalization | undefined;
  nodeGraphPorts: {
    inputs: NodeGraphPortConfig[] | undefined;
    outputs: NodeGraphPortConfig[] | undefined;
  } | undefined;
  /** 视频生成模式配置（仅适用于支持图片输入的视频模型） */
  videoGenMode: VideoGenModeConfig | undefined;
  /** Canvas 节点属性面板额外字段 */
  canvasInspector: CanvasInspectorSpec | undefined;
  /** 轻量能力位（用于替代通用链路中的 modelId 特判） */
  capabilities: Record<string, true> | undefined;
  /**
  /** 来自模型资产投影的能力位元数据（用于运行时 UI 守卫与行为开关） */
  assetCapabilities: {
    taskGroup: string | undefined;
    mediaInputMode: string | undefined;
    uiGuards: string[] | undefined;
    executionTraits: string[] | undefined;
  } | undefined;
  /** 来自模型资产投影的输入契约摘要，用于流程选择时做轻量守卫 */
  assetInputContract: ModelAssetInputContract | undefined;
  /** 变体组信息（仅主型号携带，变体成员不携带） */
  variantGroup: {
    groupKey: string;
    shellModelId: string;
    defaultModelId: string;
    variants: Array<{ modelId: string; label: string; order: number }>;
  } | undefined;
}

// 普通远端模型不再手写在这里；本地内建节点通过自动发现进入。
const manualModelsConfig: ModelConfigEntry[] = [];
const VITEST_RUNTIME_PROJECTED_MODELS_KEY = '__IART_VITEST_RUNTIME_PROJECTED_MODELS__';

const isVitestRuntime = (): boolean =>
  typeof process !== 'undefined' && process.env['VITEST'] === 'true';

const normalizeModelConfigEntry = (
  config: ModelConfigEntry | null | undefined,
): ModelConfigEntry | null => {
  if (!config) return null;
  const modelId = config.modelId !== null && config.modelId !== undefined ? config.modelId.trim() : '';
  if (!modelId) return null;
  return {
    ...config,
    modelId,
  };
};

const normalizeRuntimeProjectedModels = (configs: unknown): ModelConfigEntry[] =>
  Array.isArray(configs)
    ? configs
        .map((config) => normalizeModelConfigEntry(config as ModelConfigEntry | null | undefined))
        .filter((config): config is ModelConfigEntry => Boolean(config))
    : [];

const readVitestRuntimeProjectedModelsSeed = (): ModelConfigEntry[] => {
  if (!isVitestRuntime() || typeof globalThis === 'undefined') {
    return [];
  }

  return normalizeRuntimeProjectedModels(
    (globalThis as typeof globalThis & {
      [VITEST_RUNTIME_PROJECTED_MODELS_KEY]: unknown | undefined;
    })[VITEST_RUNTIME_PROJECTED_MODELS_KEY],
  );
};

let autoDiscoveredModels: ModelConfigEntry[] = [];
let runtimeProjectedModels: ModelConfigEntry[] = readVitestRuntimeProjectedModelsSeed();
let discoveryPromise: Promise<void> | null = null;

const isBuiltInAutoDiscoveredModel = (config: ModelConfigEntry): boolean =>
  config.providerId === 'local';

const getAutoDiscoveredBuiltinModels = (): ModelConfigEntry[] =>
  autoDiscoveredModels;

const findRuntimeProjectedModelConfigById = (modelId: string | null | undefined): ModelConfigEntry | undefined => {
  if (!modelId) return undefined;
  const key = modelId.trim().toLowerCase();
  if (!key) return undefined;
  return runtimeProjectedModels.find((config) => config.modelId.trim().toLowerCase() === key);
};

const getAllConfigs = (): ModelConfigEntry[] => {
  const map = new Map<string, ModelConfigEntry>();
  manualModelsConfig.forEach((cfg) => map.set(cfg.modelId, cfg));
  getAutoDiscoveredBuiltinModels().forEach((cfg) => map.set(cfg.modelId, cfg));
  runtimeProjectedModels.forEach((cfg) => map.set(cfg.modelId, cfg));
  return Array.from(map.values());
};

type LookupMap = Map<string, ModelConfigEntry>;

/**
 * 构建查找索引，支持多种查找方式：
 * - modelId（主键）
 * - routeSegment
 * - providerId（厂商ID）
 * - aliases（别名）
 */
const buildLookup = (configs: ModelConfigEntry[]): LookupMap => {
  const map: LookupMap = new Map();

  configs.forEach((entry) => {
    const candidates = new Set<string>();

    // 主键：modelId 永远是 canonical key
    candidates.add(entry.modelId);

    // 路由段
    if (entry.routeSegment) {
      candidates.add(entry.routeSegment);
    }

    // Provider 维度：使用 providerId
    candidates.add(entry.providerId);

    // 配置内声明的别名
    (entry.aliases ?? []).forEach((alias) => {
      if (alias) {
        candidates.add(alias);
      }
    });

    // 写入索引（normalize 为小写）
    candidates.forEach((rawKey) => {
      const key = rawKey.trim().toLowerCase();
      if (!key) return;
      if (!map.has(key)) {
        map.set(key, entry);
      }
    });
  });

  return map;
};

let lookup: LookupMap | null = null;

const refreshLookup = (): void => {
  lookup = buildLookup(getAllConfigs());
};

const ensureLookup = (): LookupMap => {
  if (!lookup) {
    refreshLookup();
  }
  if (!lookup) {
    throw new Error('model lookup init failed');
  }
  return lookup;
};

export async function initAutoDiscovery(): Promise<void> {
  // 避免重复加载与并发触发（边缘运行时会重复实例化，但同一实例内只加载一次）
  if (autoDiscoveredModels.length > 0) return;
  if (discoveryPromise) return discoveryPromise;

  discoveryPromise = (async () => {
    try {
      const discovered = await discoverModels();
      autoDiscoveredModels = discovered
        .map((config) => normalizeModelConfigEntry(config))
        .filter((config): config is ModelConfigEntry =>
          config !== null && isBuiltInAutoDiscoveredModel(config),
        );
      refreshLookup();
    } catch {
      // 忽略自动发现失败
    } finally {
      // 允许后续重试（例如首轮失败时）
      discoveryPromise = null;
    }
  })();

  return discoveryPromise;
}

/**
 * 注入 Runtime Backend 下发的模型投影配置。
 * - Runtime 投影是远端模型唯一正式真源。
 * - 自动发现只保留本地内建节点，不再承担远端模型兜底。
 */
export const setRuntimeProjectedModels = (configs: ModelConfigEntry[]): void => {
  runtimeProjectedModels = normalizeRuntimeProjectedModels(configs);
  if (isVitestRuntime() && typeof globalThis !== 'undefined') {
    (
      globalThis as typeof globalThis & {
        [VITEST_RUNTIME_PROJECTED_MODELS_KEY]: ModelConfigEntry[] | undefined;
      }
    )[VITEST_RUNTIME_PROJECTED_MODELS_KEY] = [...runtimeProjectedModels];
  }
  refreshLookup();
};

/**
 * 模型配置查找函数
 * - 支持：modelId / routeSegment / alias / providerId
 * - Runtime projected config 底层统一走 canonical modelId
 *
 * @param identifier - 模型标识符（modelId / providerId / alias / routeSegment）
 * @returns 模型配置对象，未找到时返回 undefined
 *
 * @example
 * findModelConfig('veo-3.1')          // 通过 modelId 查找
 * findModelConfig('openai')           // 通过 providerId 查找
 * findModelConfig('veo')              // 通过 alias 查找
 */
export const findModelConfig = (identifier: string | null | undefined): ModelConfigEntry | undefined => {
  if (!identifier) return undefined;
  const key = identifier.trim().toLowerCase();
  if (!key) return undefined;
  return ensureLookup().get(key);
};

export const findRuntimeProjectedModelConfigForCapability = (
  modelId: string | null | undefined,
): ModelConfigEntry | undefined => findRuntimeProjectedModelConfigById(modelId);

/**
 * 查找包含指定 modelId 的变体组主配置。
 * - 如果 modelId 对应的配置自身携带 variantGroup，直接返回该配置。
 * - 否则遍历所有配置，找到 variantGroup.variants 中包含该 modelId 的主配置。
 * - 未找到返回 undefined。
 */
export const findVariantGroupOwner = (
  modelId: string | null | undefined,
): ModelConfigEntry | undefined => {
  if (!modelId) return undefined;
  const direct = findModelConfig(modelId);
  if (direct !== null && direct !== undefined && direct.variantGroup) {
    return direct;
  }
  const all = getAllConfigs();
  for (const config of all) {
    if (!config.variantGroup) continue;
    const hasMatch = config.variantGroup.variants.some(
      (v) => v.modelId === modelId,
    );
    if (hasMatch) return config;
  }
  return undefined;
};

export const resolveCanvasModelConfig = (params: {
  shellModelId: string | null | undefined;
  modelId: string | null | undefined;
}): ModelConfigEntry | undefined => {
  const shellModelId = params.shellModelId !== null && params.shellModelId !== undefined
    ? params.shellModelId.trim()
    : '';
  if (shellModelId) {
    const shellConfig = findModelConfig(shellModelId);
    if (shellConfig !== undefined) {
      return shellConfig;
    }
  }

  const modelId = params.modelId !== null && params.modelId !== undefined
    ? params.modelId.trim()
    : '';
  if (!modelId) return undefined;
  return findVariantGroupOwner(modelId) ?? findModelConfig(modelId);
};

export const listRuntimeProjectedModelConfigs = (): ModelConfigEntry[] => [...runtimeProjectedModels];

/**
 * 提供所有模型配置的浅拷贝，避免外部意外修改原始数组
 */
export const listModelConfigs = (): ModelConfigEntry[] => getAllConfigs();

export const listVisibleModelConfigs = (): ModelConfigEntry[] =>
  listModelConfigs().filter((config) => config.visible !== false);

/**
 * 获取所有可见的生成模型配置
 * - 用于生成模型列表/选择器（例如：模型目录、推荐列表等）
 * - 仅包含 role === 'generator' 或未设置 role 的模型
 */
export const listGeneratorConfigs = (): ModelConfigEntry[] =>
  listModelConfigs().filter(
    (config) => config.visible !== false && (config.role === 'generator' || config.role === undefined)
  );

/**
 * 获取所有可见的处理节点配置
 * - 用于 Canvas 节点面板中的处理工具分类
 * - 仅包含 role === 'processor' 的模型
 */
export const listProcessorConfigs = (): ModelConfigEntry[] =>
  listModelConfigs().filter((config) => config.visible !== false && config.role === 'processor');

export const listModelConfigsWithSource = (): {
  manual: ModelConfigEntry[];
  auto: ModelConfigEntry[];
  runtime: ModelConfigEntry[];
} => ({
  manual: [...manualModelsConfig],
  auto: [...getAutoDiscoveredBuiltinModels()],
  runtime: [...runtimeProjectedModels],
});

export const getModelRouteSegment = (config: ModelConfigEntry): string =>
  config.routeSegment ?? config.modelId;

export interface ModelRouteEntry {
  config: ModelConfigEntry;
  segment: string;
}

export const getVisibleModelRouteEntries = (): ModelRouteEntry[] =>
  listVisibleModelConfigs().map((config) => ({
    config,
    segment: getModelRouteSegment(config),
  }));

export const getDefaultModelConfig = (): ModelConfigEntry | undefined =>
  listVisibleModelConfigs()[0];

export const getDefaultModelRouteSegment = (): string | undefined => {
  const config = getDefaultModelConfig();
  return config ? getModelRouteSegment(config) : undefined;
};

export default manualModelsConfig;
