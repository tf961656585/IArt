/**
 * 文件作用：模型分组（Model Group）配置层
 * - 将已知 Provider 配置抽象为 Group 元数据，统一提供 UI 所需的展示信息
 * - 提供分组查询工具函数；未知 Provider 由 catalog 动态兜底，不以本文件作为准入白名单
 */

import { listProviderConfigs, type ProviderId } from './providers.config';

/**
 * 模型分组配置，描述一个模型分组的呈现方式与基础元数据。
 */
export interface ModelGroupConfig {
  /** 分组唯一标识，默认等于所属 ProviderId，便于向后兼容 */
  id: string;
  /** 分组类型：厂商直出（provider）或自定义策展（curated） */
  type: 'provider' | 'curated';
  /** 当 type === 'provider' 时，关联的 ProviderId */
  providerId: ProviderId | undefined;
  /** 排序权重，值越小越靠前 */
  order: number;
  /** 是否在默认列表中隐藏 */
  hidden: boolean | undefined;
  /** 可选图标资源（通常复用 Provider Logo） */
  icon: string | undefined;
  /** 国际化配置，提供 label/description 的翻译 key */
  i18n: {
    labelKey: string;
    descriptionKey: string | undefined | undefined;
  } | undefined;
  /** 当 i18n 未命中时降级使用的本地化文案 */
  fallbacks: {
    label: string;
    description: string | undefined | undefined;
  };
}

/**
 * 已知 Provider 的预设展示顺序；未知 Provider 不在这里登记也允许进入目录。
 */
const providerOrder: Record<ProviderId, number> = {
  google: 10,
  openai: 20,
  alibaba: 25,
  bytedance: 30,
  vidu: 40,
  kling: 50,
  xai: 60,
  fal: 70,
  suno: 75,
  local: 80,
  example: 999,
};

/**
 * 需要默认隐藏的 Provider 分组列表。
 */
const hiddenProviders: Partial<Record<ProviderId, boolean>> = {
  example: true,
};

/**
 * 将 ProviderConfig 转换为 ModelGroupConfig，并与 order 配置相结合。
 */
const providerGroups: ModelGroupConfig[] = listProviderConfigs()
  .map<ModelGroupConfig>((provider) => ({
    id: provider.id,
    type: 'provider',
    providerId: provider.id,
    order: providerOrder[provider.id] ?? Number.MAX_SAFE_INTEGER,
    hidden: hiddenProviders[provider.id] === true,
    icon: provider.logo,
    i18n: {
      labelKey: `providers.${provider.id}.displayName`,
      descriptionKey: provider.description ? `providers.${provider.id}.description` : undefined,
    },
    fallbacks: {
      label: provider.displayName,
      description: provider.description,
    },
  }))
  .sort((a, b) => a.order - b.order);

const curatedGroups: ModelGroupConfig[] = [];

/**
 * 所有模型分组（已按 order 排序）。
 */
const allGroups: ModelGroupConfig[] = [...providerGroups, ...curatedGroups];

/**
 * 基于分组 id 构建索引，提供 O(1) 查询能力。
 */
const groupIndex = new Map<string, ModelGroupConfig>();
allGroups.forEach((group) => {
  if (!groupIndex.has(group.id)) {
    groupIndex.set(group.id, group);
  }
});

/**
 * 列出所有模型分组。
 * @returns 已按 order 升序排列的 ModelGroupConfig 列表
 */
export const listModelGroups = (): ModelGroupConfig[] => [...allGroups];

/**
 * 根据分组 ID 查询配置。
 * @param groupId - 目标分组唯一标识（默认等于 providerId）
 */
export const findModelGroup = (groupId: string | null | undefined): ModelGroupConfig | undefined => {
  if (!groupId) return undefined;
  const normalizedId = groupId.trim();
  if (!normalizedId) return undefined;
  return groupIndex.get(normalizedId);
};

/**
 * 获取所有可见分组（hidden === true 的分组会被过滤）。
 * @returns UI 层可直接渲染的分组列表，顺序与 listModelGroups 一致
 */
export const getVisibleGroups = (): ModelGroupConfig[] =>
  allGroups.filter((group) => !group.hidden);
