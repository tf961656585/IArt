import type { ProviderConnection } from '@iart/contracts';
import type { ConfirmDeleteGenerationModelTarget } from './useGenerationModelManagement';

/**
 * 删除确认弹层的标题与影响面文案（自 ProviderSection 拆出的纯映射，可单测）。
 *
 * 确认目标类型与文案在同一处：新增一种确认目标时，标题与影响面说明必须同时给，
 * 漏一边会渲染出「确认操作 / 空文案」的兜底串。
 */

export type ConfirmTarget =
  | { kind: 'delete-provider'; connection: ProviderConnection }
  | { kind: 'clear-credential'; connection: ProviderConnection }
  | { kind: 'delete-thinking-tier'; name: string; usedByModels: number }
  | { kind: 'delete-custom-model'; modelId: string }
  | ConfirmDeleteGenerationModelTarget
  | null;

export function confirmTitle(target: ConfirmTarget): string {
  switch (target?.kind) {
    case 'delete-provider': return '删除服务商';
    case 'clear-credential': return '删除密钥';
    case 'delete-thinking-tier': return '删除档位';
    case 'delete-custom-model': return '删除模型';
    case 'delete-custom-generation-model': return '删除模型';
    default: return '确认操作';
  }
}

/**
 * 影响面文案：只回答「会连带发生什么」，不解释机制、不按来源分说
 * （`docs/ui-copy-standard.md`：模型不区分来源，一个模型只有一处能删）。
 */
export function confirmMessage(
  target: ConfirmTarget,
  modelCounts: ReadonlyMap<string, number>,
): string {
  switch (target?.kind) {
    case 'delete-provider': {
      // 后端级联见 provider-connection-routes DELETE（spec 03 §5.3）：连接与它挂着的全部模型
      // 记录一并移除。模型记录归属创建它的连接，不存在无归属的模型，因此没有「摘掉接入、
      // 模型本体留着」这种第二去向可交代。
      const models = modelCounts.get(target.connection.connection_id) ?? 0;
      return models > 0
        ? `确定删除「${target.connection.display_name}」吗？在这里添加的 ${models} 个模型会一并删除。`
        : `确定删除「${target.connection.display_name}」吗？`;
    }
    case 'clear-credential': {
      // 删密钥不删记录：模型都还在，只是都不可用了
      const affected = modelCounts.get(target.connection.connection_id) ?? 0;
      return affected === 0
        ? `确定删除「${target.connection.display_name}」的密钥吗？`
        : `确定删除「${target.connection.display_name}」的密钥吗？它下面的 ${affected} 个模型会变成不可用。`;
    }
    case 'delete-thinking-tier':
      return target.usedByModels === 0
        ? `确定删除档位「${target.name}」吗？`
        : `确定删除档位「${target.name}」吗？正在用它的 ${target.usedByModels} 个模型会失去这个档位。`;
    case 'delete-custom-model':
      return `确定删除「${target.modelId}」吗？删除后它会从模型列表里消失，Agent 也不再能用它。`;
    case 'delete-custom-generation-model':
      return `确定删除「${target.modelId}」吗？删除后它会从模型列表里消失，画布里也没法再用它生成。`;
    default:
      return '';
  }
}
