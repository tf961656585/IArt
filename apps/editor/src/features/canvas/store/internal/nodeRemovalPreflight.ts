/**
 * 节点删除前置钩子（注册式，单槽位，无模块环）。
 *
 * 存在的理由：删除 Agent 节点的语义是「先在途终止再删除」
 *（docs/agent/02-Agent节点与画布投影.md「撤销重做与删除」），但在途终止的能力属于
 * features/agent（会话 + socket owner）。canvas store 不得反向 import features/agent
 *（会造成模块环），因此 canvas 只提供注册位：由 agent 侧在项目加载链显式注册自己的
 * 终止函数，删除入口在改动图数据之前同步调用。
 *
 * 约束（改动前请先读）：
 * - 单槽位覆盖式注册：重复注册不叠加（幂等），后注册者生效；
 * - 调用是同步的：钩子内只做「立即把取消消息派发出去 + 标记会话作废」这类不等待 I/O 的
 *   动作。`removeNode` / `removeNodes` 是同步事务，不得为了等钩子而改成异步；
 * - 无注册者时是 no-op（无 agent 会话的场景/测试行为不变），但仍记 debug 日志
 *  （仓库规则：条件跳过必须留痕）。
 */

/** 前置钩子形状：只消费被删除节点 id，不返回值、不抛错。 */
export type NodeRemovalPreflight = (nodeIds: readonly string[]) => void;

/** 单槽位注册位（覆盖式，避免重复注册叠加出多次取消派发）。 */
let preflight: NodeRemovalPreflight | null = null;

/** 注册删除前置钩子（幂等：单槽位覆盖，不叠加）。 */
export const registerNodeRemovalPreflight = (fn: NodeRemovalPreflight): void => {
  preflight = fn;
};

/** 注销删除前置钩子（项目关闭 / 测试复位用）。 */
export const unregisterNodeRemovalPreflight = (): void => {
  preflight = null;
};

/**
 * 同步调用删除前置钩子；返回是否真的调用了注册者（无注册者时为 false）。
 *
 * 调用点必须保证在「展开 companion / 解散组 / 修改图数据」之前，
 * 否则被删除节点的会话可能在删除后才终止，残留事件仍会写入已删除会话。
 */
export const runNodeRemovalPreflight = (nodeIds: readonly string[]): boolean => {
  if (nodeIds.length === 0) {
    console.debug('[nodeRemovalPreflight] skipped: empty node id set');
    return false;
  }
  const handler = preflight;
  if (!handler) {
    console.debug('[nodeRemovalPreflight] no handler registered, skip', {
      nodeIdCount: nodeIds.length,
    });
    return false;
  }
  try {
    handler(nodeIds);
    return true;
  } catch (error) {
    // 前置钩子失败不阻断删除本身（图数据变更仍要完成），但必须留痕，不静默吞掉。
    console.warn('[nodeRemovalPreflight] handler failed', { nodeIds, error });
    return false;
  }
};
