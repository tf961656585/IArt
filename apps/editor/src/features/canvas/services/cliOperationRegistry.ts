/**
 * CLI 按操作撤销 · 画布窗口内逆操作登记表（spec docs/integrations/CLI与本地Agent集成.md §5.3）。
 *
 * 职责边界：
 * - 写命令成功后把「该次批量写入的逆操作」登记为 operationId → 逆位移；
 * - `canvas.undo --operation <id>` 取出逆操作、应用后移除该 id；
 * - 非位置类写命令（建组 / 解散 / 添加移出成员 / 删除 / 导入）也登记一条 `unsupported`
 *   记录——它们返回的 operation_id 能被识别为「存在但按操作撤销不支持」，而不是
 *   operation_not_found（若完全不登记，两种情形无法区分）。
 *
 * 生命周期边界（已知且显式）：登记表只存在于画布窗口渲染进程内存，窗口重载/重建即失效。
 * 失效后的 id 一律按 `operation_not_found` 返回（错误信息说明「操作记录已失效或不存在」）。
 *
 * 本模块不触碰 store、不产生历史；逆操作的「应用」由调用方经既有批量位置写入 action 完成
 * （一次应用 = 一条新的历史记录，因此这次撤销本身可被 Cmd+Z 反悔）。
 */

import type { NodePosition } from '@/features/canvas/types';

/** 逆位移项：把节点恢复到该次操作前的位置。 */
export type CliOperationInversePosition = {
  id: string;
  position: NodePosition;
};

/** 登记表条目：位置类（可撤销）或显式不支持按操作撤销。 */
export type CliOperationRecord =
  | {
      kind: 'position';
      /** 该次操作实际位移的全部节点及其操作前位置（含伴随节点与容器派生位移）。 */
      inverse: CliOperationInversePosition[];
    }
  | { kind: 'unsupported' };

/**
 * 登记表容量上限：超出后按插入序淘汰最旧条目（防长会话无界增长）。
 * 淘汰只影响老 operation_id 的可撤销性，不影响任何画布数据。
 */
const MAX_REGISTERED_OPERATIONS = 200;

const registry = new Map<string, CliOperationRecord>();

const createOperationId = (): string => {
  const cryptoApi: Crypto | undefined = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  // 兜底：宿主无 WebCrypto（部分测试环境）。仍保证窗口内唯一且不透露时间语义。
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const register = (record: CliOperationRecord): string => {
  const operationId = createOperationId();
  registry.set(operationId, record);
  while (registry.size > MAX_REGISTERED_OPERATIONS) {
    const oldest = registry.keys().next();
    if (oldest.done === true) break;
    registry.delete(oldest.value);
    console.debug('[cliOperationRegistry] operation record evicted (capacity)', {
      max: MAX_REGISTERED_OPERATIONS,
    });
  }
  return operationId;
};

/** 登记一次位置写入的逆操作，返回本次操作的撤销标识。 */
export const registerPositionOperation = (inverse: CliOperationInversePosition[]): string =>
  register({ kind: 'position', inverse });

/** 登记一次「存在但按操作撤销不支持」的写命令，返回该命令的操作标识。 */
export const registerUnsupportedOperation = (): string => register({ kind: 'unsupported' });

/** 读取登记条目（不删除）。未登记返回 undefined。 */
export const readCliOperation = (operationId: string): CliOperationRecord | undefined =>
  registry.get(operationId);

/** 移除登记条目（撤销应用成功后调用；id 不可再次撤销）。 */
export const removeCliOperation = (operationId: string): void => {
  registry.delete(operationId);
};

/** 清空登记表（仅测试与画布重建使用；生产不需调用）。 */
export const clearCliOperations = (): void => {
  registry.clear();
};

/** 当前登记条目数（测试与诊断用）。 */
export const getCliOperationCount = (): number => registry.size;
