/**
 * Editor 内建模型发现
 * - 仅发现本地 processor / 内建节点
 * - 普通远端模型由 Runtime projection 提供
 */
import { isValidModelDefinition, toModelConfigEntry } from '@/features/models/modelDefinition';
import { modelLoaders } from './modelAutoDiscovery.generated';
import type { ModelConfigEntry } from './models.config';

/**
 * 导入已生成索引中的本地内建模型定义。
 */
async function importAllModelDefinitions(): Promise<unknown[]> {
  const definitions: unknown[] = [];

  for (const { key: _key, loader } of modelLoaders) {
    try {
      const mod = await loader();
      if ((mod !== null && mod !== undefined ? mod.MODEL_DEFINITION : undefined)) {
        definitions.push(mod.MODEL_DEFINITION);
      }
    } catch {
      // 忽略加载失败的模型
    }
  }

  return definitions;
}

/**
 * 发现并转换本地内建模型配置
 * @returns 自动发现的 ModelConfigEntry 数组
 */
export async function discoverModels(): Promise<ModelConfigEntry[]> {
  const definitions = await importAllModelDefinitions();
  const configs: ModelConfigEntry[] = [];

  for (const def of definitions) {
    if (!isValidModelDefinition(def)) {
      continue;
    }

    configs.push(toModelConfigEntry(def));
  }

  return configs;
}
