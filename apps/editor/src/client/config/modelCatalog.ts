import { getModelRouteSegment, type ModelConfigEntry } from './models.config';
import { findModelGroup, listModelGroups, type ModelGroupConfig } from './modelGroups.config';
import { getProviderConfig, getProviderConfigOrFallback } from './providers.config';
import type { ModelItem } from '../store/modelStore';

export interface ModelCatalogGroup {
  id: string;
  order: number;
  hidden: boolean;
  label: string;
  icon: string | undefined | undefined;
  description: string | undefined | undefined;
}

export type ModelCatalogModel = ModelItem;

export interface ModelCatalog {
  groups: ModelCatalogGroup[];
  modelsByGroup: Record<string, ModelCatalogModel[]>;
}

type TranslateFn = (key: string, options: { defaultValue: string | undefined } | undefined) => string;

type GroupConfigCache = Map<string, ModelGroupConfig | null>;

type CatalogGroupCache = Map<string, ModelCatalogGroup>;

const warnMissingGroupOnce = (missingGroupIds: Set<string>, groupId: string, modelId: string) => {
  if (missingGroupIds.has(groupId)) {
    return;
  }
  missingGroupIds.add(groupId);
  console.warn(
    `[ModelCatalog] 分组 "${groupId}" 不存在，模型 "${modelId}" 将使用动态分组兜底。`,
  );
};

const normalizeGroupId = (config: ModelConfigEntry): string => {
  const provided = config.groupId !== null && config.groupId !== undefined ? config.groupId.trim() : undefined;
  return provided && provided.length > 0 ? provided : config.providerId;
};

const translateWithFallback = (
  translate: TranslateFn,
  key: string,
  fallback: string | undefined,
): string | undefined => {
  const options = fallback !== undefined ? { defaultValue: fallback } : undefined;
  try {
    const result = translate(key, options);
    if (typeof result === 'string') {
      const trimmed = result.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  } catch {
    return fallback;
  }
  return fallback;
};

const resolveGroupLabel = (group: ModelGroupConfig, translate: TranslateFn): string => {
  const fallback = group.fallbacks.label;
  const labelKey = (group.i18n !== null && group.i18n !== undefined ? group.i18n.labelKey : undefined);
  if (!labelKey) {
    return fallback;
  }
  return translateWithFallback(translate, labelKey, fallback) ?? fallback;
};

const resolveGroupDescription = (group: ModelGroupConfig, translate: TranslateFn): string | undefined => {
  const fallback = group.fallbacks.description;
  const descriptionKey = (group.i18n !== null && group.i18n !== undefined ? group.i18n.descriptionKey : undefined);
  if (!descriptionKey) {
    return fallback;
  }
  return translateWithFallback(translate, descriptionKey, fallback) ?? fallback;
};

const resolveModelLabel = (config: ModelConfigEntry): string => {
  const providerConfig = getProviderConfig(config.providerId);
  const providerLabel = (providerConfig !== null && providerConfig !== undefined ? providerConfig.displayName : undefined) ?? config.modelId;
  return config.label ?? providerLabel;
};

const resolveModelDescription = (): string | undefined => undefined;

const getCachedGroupConfig = (
  groupId: string,
  cache: GroupConfigCache,
): ModelGroupConfig | null => {
  if (cache.has(groupId)) {
    return cache.get(groupId) ?? null;
  }
  const config = findModelGroup(groupId) ?? null;
  cache.set(groupId, config);
  return config;
};

const ensureCatalogGroup = (
  groupConfig: ModelGroupConfig,
  translate: TranslateFn,
  cache: CatalogGroupCache,
): ModelCatalogGroup => {
  const existing = cache.get(groupConfig.id);
  if (existing) {
    return existing;
  }
  const group: ModelCatalogGroup = {
    id: groupConfig.id,
    order: groupConfig.order,
    hidden: Boolean(groupConfig.hidden),
    label: resolveGroupLabel(groupConfig, translate),
    icon: groupConfig.icon,
    description: resolveGroupDescription(groupConfig, translate),
  };
  cache.set(group.id, group);
  return group;
};

const ensureDynamicCatalogGroup = (
  config: ModelConfigEntry,
  groupId: string,
  cache: CatalogGroupCache,
): ModelCatalogGroup => {
  const existing = cache.get(groupId);
  if (existing) {
    return existing;
  }

  const provider = getProviderConfig(config.providerId) ?? getProviderConfigOrFallback(groupId);
  const group: ModelCatalogGroup = {
    id: groupId,
    order: Number.MAX_SAFE_INTEGER,
    hidden: false,
    label: provider.displayName || groupId,
    icon: provider.logo,
    description: provider.description,
  };
  cache.set(group.id, group);
  return group;
};

const buildCatalogModel = (
  config: ModelConfigEntry,
  group: ModelCatalogGroup,
): ModelCatalogModel => ({
  label: resolveModelLabel(config),
  value: config.modelId,
  desc: resolveModelDescription(),
  routeSegment: getModelRouteSegment(config),
  mode: config.mode,
  groupId: group.id,
  groupLabel: group.label,
  groupOrder: group.order,
});

export function buildModelCatalog(
  configs: ModelConfigEntry[],
  i18nTranslate: TranslateFn,
): ModelCatalog {
  const groupConfigCache: GroupConfigCache = new Map();
  const catalogGroupCache: CatalogGroupCache = new Map();
  const modelsByGroup = new Map<string, ModelCatalogModel[]>();
  const missingGroupIds = new Set<string>();

  listModelGroups().forEach((groupConfig) => {
    if (!groupConfigCache.has(groupConfig.id)) {
      groupConfigCache.set(groupConfig.id, groupConfig);
    }
    if (groupConfig.hidden) {
      return;
    }
    const group = ensureCatalogGroup(groupConfig, i18nTranslate, catalogGroupCache);
    if (!modelsByGroup.has(group.id)) {
      modelsByGroup.set(group.id, []);
    }
  });

  configs.forEach((config) => {
    const groupId = normalizeGroupId(config);
    const groupConfig = getCachedGroupConfig(groupId, groupConfigCache);

    if ((groupConfig !== null && groupConfig !== undefined ? groupConfig.hidden : undefined)) {
      return;
    }

    const catalogGroup = groupConfig
      ? ensureCatalogGroup(groupConfig, i18nTranslate, catalogGroupCache)
      : ensureDynamicCatalogGroup(config, groupId, catalogGroupCache);

    if (!groupConfig) {
      warnMissingGroupOnce(missingGroupIds, groupId, config.modelId);
    }

    const catalogModel = buildCatalogModel(config, catalogGroup);
    const list = modelsByGroup.get(catalogGroup.id);
    if (list) {
      list.push(catalogModel);
    } else {
      modelsByGroup.set(catalogGroup.id, [catalogModel]);
    }
  });

  const groups = Array.from(catalogGroupCache.values()).sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.label.localeCompare(b.label, 'zh-Hans');
  });
  const groupedModels: Record<string, ModelCatalogModel[]> = {};

  groups.forEach((group) => {
    groupedModels[group.id] = modelsByGroup.get(group.id) ?? [];
  });

  return {
    groups,
    modelsByGroup: groupedModels,
  };
}
