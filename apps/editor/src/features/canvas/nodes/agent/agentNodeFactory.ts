import type { NodeDefinition } from '../registry';
import type { NodeSize } from '../../types/node';

/**
 * Agent 节点工厂（Todo 批次 4）。
 *
 * Agent 节点是 agent 会话的画布锚点（spec docs/agent/02-Agent节点与画布投影.md）：
 * 唯一创建触发事实是 PromptDock agent 提交被 Backend `agent:accepted` 受理
 *（features/agent/agentNodeProjection 承载创建），因此 palette 不可见；
 * 后续 token/complete/error 与项目恢复只更新会话数据，绝不凭会话 id 建节点。
 *
 * 节点只持 `agentSessionId` 稳定引用：模型 / 思考 / 审批 / 标题 / 消息量与会话历史
 * 全部来自会话存储，节点 data 不承载历史（spec 02 禁止项）。
 */

export const AGENT_NODE_LABEL = 'Agent';

/**
 * Agent 节点默认尺寸（节点头部：模型 model_id 直显 + 会话摘要两行）。
 * 尺寸稳定不随内容伸缩，故走 static size strategy（注册期校验要求 defaultSize）；
 * 宽高对齐原型 prototypes/shared/node-agent.css 的 240px 卡宽。
 */
export const AGENT_NODE_DEFAULT_SIZE: NodeSize = { width: 240, height: 64 };

const baseOptionalFields = {
  defaultSize: undefined as NodeSize | undefined,
  sizeStrategy: undefined as NodeDefinition['sizeStrategy'],
  modelId: undefined as string | undefined,
  providerId: undefined as string | undefined,
  groupId: undefined as string | undefined,
  bundle: undefined as NodeDefinition['bundle'],
  palette: undefined as NodeDefinition['palette'],
  companions: undefined as NodeDefinition['companions'],
  variantGroup: undefined as NodeDefinition['variantGroup'],
} as const;

export const agentNodeDefinition: NodeDefinition = {
  ...baseOptionalFields,
  type: 'agent',
  label: AGENT_NODE_LABEL,
  description: '和 Agent 交流的节点，多轮历史在右侧会话视图查看',
  category: 'utility',
  icon: 'agent',
  defaultData: {
    label: AGENT_NODE_LABEL,
    agentSessionId: '',
  },
  defaultSize: AGENT_NODE_DEFAULT_SIZE,
  sizeStrategy: { mode: 'static' },
  deletable: true,
  // 节点 ↔ 会话固定 1:1：复制会产生共享同一会话的两个节点，破坏绑定不变量，禁止复制。
  copyable: false,
  color: '#0ea5e9',
  executable: false,
  palette: { visible: false },
};
