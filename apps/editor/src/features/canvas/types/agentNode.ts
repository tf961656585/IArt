/**
 * Agent 节点数据的 Editor-local 类型（Todo 批次 4）。
 *
 * Agent 节点是 agent 会话的画布锚点（spec docs/agent/02-Agent节点与画布投影.md）：
 * 节点只持会话稳定引用 `agentSessionId`，会话元数据（模型 / 思考 / 审批 / 标题 /
 * 消息量）与历史消息一律以会话存储为唯一事实源，禁止塞进节点 data。
 *
 * 归属：节点 data 容器是 Editor 单进程展示层对象，归 Editor 内部类型（AGENTS.md
 * 「契约层级判定准则」）；其内嵌的会话引用（AgentSessionRecord / AgentMessageRecord / AgentSendRecord）
 * 由 packages/contracts 定义，本文件不复制其字段。
 */

/** Agent 节点数据：只持会话稳定引用。 */
export type AgentNodeData = {
  /** 显示标签 */
  label: string;
  /**
   * 会话稳定身份（节点 ↔ 会话固定 1:1）。
   * 节点只持该引用：历史/元数据以会话存储为唯一事实源，不从节点 data 读取会话内容。
   */
  agentSessionId: string;
  /**
   * Agent 容器折叠态（复用组折叠机制，spec docs/runtime/画布节点组.md「折叠」）：
   * false/缺省为展开，true 为折叠。折叠只改变呈现，不改容器 id、成员 groupId、
   * 成员位置与会话数据（AG-CN-008）。随节点 data JSON 整存整取持久化。
   */
  collapsed?: boolean | undefined;
};
