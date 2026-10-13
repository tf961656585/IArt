import type { GraphNode, NodeGraph } from '../types';
import type { TaskNodeData } from '../types/taskNode';

/**
 * 「失败节点」判定与收集（spec：docs/editor/画布对象右键菜单.md §7.6）。
 *
 * 失败节点 = 画布上承载一次生成任务、状态停在 `failed` 终态的任务节点投影。
 * 用户主动取消的任务在取消被受理时即从画布移除投影（`cancelled` 终态通知对已移除投影
 * 幂等忽略），因此取消不产生留在画布上的节点，不参与本判定——判定只看 `failed` 一个状态。
 *
 * 本文件是「哪些节点算失败节点」的唯一实现：菜单项可用性、确认框数量、实际删除集合
 * 都经此处取值，禁止各处自行 filter（避免三个事实源对不上）。
 */

/** 节点是否为失败终态的任务节点。 */
export const isFailedTaskNode = (node: GraphNode): boolean =>
  node.type === 'task' && (node.data as TaskNodeData).status === 'failed';

/** 收集画布上全部失败任务节点的 id；画板未就绪（null / undefined）时返回空集合。 */
export const collectFailedTaskNodeIds = (
  nodeGraph: NodeGraph | null | undefined,
): string[] => {
  if (nodeGraph === null || nodeGraph === undefined) return [];
  return nodeGraph.nodes.filter(isFailedTaskNode).map((node) => node.id);
};
