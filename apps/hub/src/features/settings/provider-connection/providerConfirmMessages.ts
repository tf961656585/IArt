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
  | { kind: 'remove-model'; deploymentId: string; modelId: string }
  | { kind: 'delete-thinking-tier'; name: string; usedByModels: number }
  | { kind: 'delete-custom-model'; modelId: string }
  | ConfirmDeleteGenerationModelTarget
  | null;

export function confirmTitle(target: ConfirmTarget): string {
  switch (target?.kind) {
    case 'delete-provider': return '删除服务商';
    case 'clear-credential': return '删除密钥';
    case 'remove-model': return '移除模型';
    case 'delete-thinking-tier': return '删除档位';
    case 'delete-custom-model': return '删除模型';
    case 'delete-custom-generation-model': return '删除模型';
    default: return '确认操作';
  }
}

export function confirmMessage(
  target: ConfirmTarget,
  installedCounts: ReadonlyMap<string, number>,
  customCounts: ReadonlyMap<string, number>,
): string {
  switch (target?.kind) {
    case 'delete-provider': {
      const installed = installedCounts.get(target.connection.connection_id) ?? 0;
      const custom = customCounts.get(target.connection.connection_id) ?? 0;
      // 两种来源分开说、各按真实去向说（后端级联见 provider-connection-routes DELETE，spec 03 §5.3）：
      // 自建记录被级联删除（模型本身消失）；自带模型只摘这条接入，本体还在自带目录、可再添加到
      // 其他服务商——对自带模型说「删除」会失真
      if (installed > 0 && custom > 0) {
        return `确定删除「${target.connection.display_name}」吗？删除后，在这里添加的 ${custom} 个模型会一并删除；软件自带的 ${installed} 个模型之后可添加到其他服务商。`;
      }
      if (installed > 0) {
        return `确定删除「${target.connection.display_name}」吗？软件自带的 ${installed} 个模型之后可添加到其他服务商。`;
      }
      if (custom > 0) {
        return `确定删除「${target.connection.display_name}」吗？在这里添加的 ${custom} 个模型会一并删除。`;
      }
      return `确定删除「${target.connection.display_name}」吗？`;
    }
    case 'clear-credential': {
      // 删密钥不删记录：接入与自建记录都还在，只是都不可用了——合并成一个数
      const affected = (installedCounts.get(target.connection.connection_id) ?? 0)
        + (customCounts.get(target.connection.connection_id) ?? 0);
      return affected === 0
        ? `确定删除「${target.connection.display_name}」的密钥吗？`
        : `确定删除「${target.connection.display_name}」的密钥吗？它下面的 ${affected} 个模型会变成不可用。`;
    }
    case 'remove-model':
      return `确定移除「${target.modelId}」吗？移除后可再次添加。`;
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
