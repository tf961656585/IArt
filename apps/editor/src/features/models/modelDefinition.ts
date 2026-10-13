/**
 * 统一模型定义接口
 * - 每个模型的 index.ts 必须导出此格式的对象
 */
import type { GenerationAdapter } from '@/client/adapters/types';
import type {
  ModelConfigEntry,
  CanvasPortSpec,
  CanvasInspectorSpec,
  ModelCopyLocalization,
  ModelRole,
  VideoGenModeConfig,
} from '@/client/config/models.config';
import type { ProviderId } from '@/client/config/providers.config';
import type { DynamicRecord } from '@/client/utils/typeGuards';
import type { ModelWorkspaceConfig } from '@/features/workspace/modelFormTypes';

// 重新导出 ModelRole 以便其他模块使用
export type { ModelRole } from '@/client/config/models.config';

type DynamicModelCapabilitiesProbe = {
  capabilities: { [K in ModelCapabilityKey]?: unknown } | undefined;
};

export interface ModelDefinition {
  /** 正式模型身份(kebab-case)，Runtime/投影主链统一以此为 canonical key */
  modelId: string;
  /** 本地节点/历史调用方别名，不作为正式主键 */
  /** 所属 Provider ID */
  providerId: ProviderId;
  /** 分组 ID(可选,默认等于 providerId) */
  groupId: string | undefined;
  /** 显示名称 */
  label: string;
  /** 模型描述 */
  description: string | undefined;
  /** 别名列表 */
  aliases: string[] | undefined;
  /** 路由段(可选,默认等于 modelId) */
  routeSegment: string | undefined;
  /** 默认任务类型 */
  defaultTaskType: 'text' | 'image' | 'video' | 'audio' | 'multimodal';
  /** UI 模式 */
  mode: 'text' | 'image' | 'video';
  /** 是否在 UI 中可见(默认 true) */
  visible: boolean | undefined;
  /** 模型角色：generator = 生成模型，processor = 处理节点（默认 generator） */
  role: ModelRole | undefined;
  /** API 适配器实例 */
  adapter: GenerationAdapter;
  /** 请求默认配置 */
  defaults: DynamicRecord | undefined;
  /** Workspace 配置 */
  workspace: ModelWorkspaceConfig | undefined;
  /** Canvas 端口规范 */
  canvasPortSpec: CanvasPortSpec | undefined;
  /**
   * 可选：按版本（通常为表单字段 `model`）提供差异化 canvas 端口规范
   * - key 为版本值
   * - 支持提供 `default` 作为兜底
   */
  canvasPortSpecByVersion: Record<string, CanvasPortSpec> | undefined;
  /** 国际化配置 */
  i18n: ModelCopyLocalization | undefined;
  /** 显式节点端口配置(可选) */
  nodeGraphPorts: ModelConfigEntry['nodeGraphPorts'] | undefined;
  /** 视频生成模式配置（仅适用于支持图片输入的视频模型） */
  videoGenMode: VideoGenModeConfig | undefined;
  /** Canvas 节点属性面板额外字段（仅面板可配，不开放为端口） */
  canvasInspector: CanvasInspectorSpec | undefined;

  /** 模型能力声明（用于 UI/功能开关，避免硬编码模型身份） */
  capabilities: ModelCapabilities | undefined;
}

export const MODEL_CAPABILITY_KEYS = {
  uiInlineParamsReadabilityGuard: 'ui.inlineParamsReadabilityGuard',
  uiInlineParamsSkipImageSize: 'ui.inlineParamsSkipImageSize',
  uiReferenceImageOrderPanel: 'ui.referenceImageOrderPanel',
  uiPromptMention: 'ui.promptMention',
  executionMediaPromptOptimizer: 'execution.mediaPromptOptimizer',
} as const;

export type ModelCapabilityKey = (typeof MODEL_CAPABILITY_KEYS)[keyof typeof MODEL_CAPABILITY_KEYS];

export type ModelCapabilities = Partial<Record<ModelCapabilityKey, true>>;

export function hasModelCapability(target: unknown, capability: ModelCapabilityKey): boolean {
  if (!target || typeof target !== 'object') return false;
  const caps = (target as DynamicModelCapabilitiesProbe).capabilities;
  if (!caps || typeof caps !== 'object') return false;
  return caps[capability] === true;
}

/**
 * 类型守卫:检查对象是否为有效的 ModelDefinition
 */
export function isValidModelDefinition(obj: unknown): obj is ModelDefinition {
  if (!obj || typeof obj !== 'object') return false;
  const def = obj as Partial<ModelDefinition>;

  return !!(
    typeof def.modelId === 'string' &&
    typeof def.providerId === 'string' &&
    typeof def.label === 'string' &&
    typeof def.defaultTaskType === 'string' &&
    typeof def.mode === 'string' &&
    def.adapter &&
    typeof def.adapter.generate === 'function'
  );
}

/**
 * 将 ModelDefinition 转换为 ModelConfigEntry
 */
export function toModelConfigEntry(def: ModelDefinition): ModelConfigEntry {    
  return {
    providerId: def.providerId,
    groupId: def.groupId,
    label: def.label,
    modelId: def.modelId,
    defaultTaskType: def.defaultTaskType,
    mode: def.mode,
    adapter: def.adapter,
    defaults: def.defaults,
    visible: def.visible,
    role: def.role ?? 'generator',
    description: def.description,
    aliases: def.aliases,
    routeSegment: def.routeSegment,
    workspace: def.workspace,
    canvasPortSpec: def.canvasPortSpec,
    i18n: def.i18n,
    nodeGraphPorts: def.nodeGraphPorts,
    videoGenMode: def.videoGenMode,
    canvasInspector: def.canvasInspector,
    capabilities: def.capabilities,
    assetCapabilities: undefined,
    assetInputContract: undefined,
    variantGroup: undefined,
  };
}
