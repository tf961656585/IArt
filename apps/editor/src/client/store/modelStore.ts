/**
 * 文件作用：全局模型状态（运行时）管理
 * - 严格职责：仅保存运行时的 currentModel 与 models 列表，并提供设置方法
 * - 模型来源统一由 models.config.ts 提供，避免多重数据源
 */
import { createWithEqualityFn } from 'zustand/traditional';
import {
  listGeneratorConfigs,
  findModelConfig,
} from '../config/models.config';
import type { ModelMode } from '../config/models.config';
import { getClientI18n } from '@/lib/i18n/client';
import { buildModelCatalog, type ModelCatalog } from '../config/modelCatalog';

/** 单个模型条目类型 */
export interface ModelItem {
  label: string;
  value: string;
  desc: string | undefined | undefined;
  routeSegment: string;
  mode: ModelMode;
  groupId: string;
  groupLabel: string;
  groupOrder: number;
}

interface ModelState {
  currentModel: string;
  setModel: (m: string) => void;
  models: ModelItem[];
  setModels: (arr: ModelItem[]) => void;
  catalog: ModelCatalog | null;
  setCatalog: (catalog: ModelCatalog) => void;
}

/**
 * 使用 zustand 保存运行时状态
 * - 初始状态为空，由 initModelStore 或其他初始化流程填充
 */
export const useModelStore = createWithEqualityFn<ModelState>()((set) => ({
  currentModel: '',
  setModel: (m: string) => set({ currentModel: m }),
  models: [],
  setModels: (arr: ModelItem[]) =>
    set((state) => {
      const nextList = arr;
      const hasCurrent = nextList.some((item) => item.value === state.currentModel);
      const newCurrent = hasCurrent ? state.currentModel : (nextList[0] !== null && nextList[0] !== undefined ? nextList[0].value : undefined) ?? '';
      return { models: nextList, currentModel: newCurrent };
    }),
  catalog: null,
  setCatalog: (catalog: ModelCatalog) => set({ catalog }),
}));

/**
 * 根据 models.config.ts 初始化 models 列表
 * - 遵循配置中的顺序与可见性
 */
export async function initModelStore(): Promise<void> {
  try {
    const { items, catalog } = buildModelItems();
    if (items.length === 0) return;
    const state = useModelStore.getState();
    state.setModels(items);
    state.setCatalog(catalog);
  } catch {
    // 初始化失败时静默回退，避免阻塞主流程
  }
}

const buildModelItems = (): { items: ModelItem[]; catalog: ModelCatalog } => {
  const i18n = getClientI18n();
  const translate = i18n.t.bind(i18n) as (key: string, options: { defaultValue: string | undefined } | undefined) => string;

  // 仅使用生成模型（排除 processor 类型），用于生成模型列表/选择器
  const catalog = buildModelCatalog(listGeneratorConfigs(), translate);

  const items: ModelItem[] = [];
  Object.values(catalog.modelsByGroup).forEach((groupModels) => {
    items.push(...groupModels);
  });

  return { items, catalog };
};

if (typeof window !== 'undefined') {
  const i18n = getClientI18n();
  i18n.on('languageChanged', () => {
    const { items, catalog } = buildModelItems();
    if (items.length === 0) {
      return;
    }
    const state = useModelStore.getState();
    state.setModels(items);
    state.setCatalog(catalog);
  });
}

/**
 * 便捷函数：根据任意标识获取模型配置
 */
export const getModelConfig = (identifier: string | null | undefined) => findModelConfig(identifier ?? undefined);

export default useModelStore;
