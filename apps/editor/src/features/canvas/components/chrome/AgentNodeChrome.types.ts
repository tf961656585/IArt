import type { GraphNode } from '../../types/node';
import type { AgentChromeSelection } from './agentChromeModel';

/**
 * Agent 节点选中态工具栏类型（spec docs/agent/02-Agent节点与画布投影.md「选中态工具栏」）。
 * Props 独立文件（component-scaffold 规范）。
 */

export type AgentChromeState = {
  selection: AgentChromeSelection;
  /** 单选 Agent 节点（多选/空为 null） */
  single: GraphNode | null;
  /** 单选节点持有的会话稳定引用（会话引用缺失为 null） */
  agentSessionId: string | null;
  /**
   * PromptDock 当前是否已处于该节点的会话（agent 形态 + 绑定同一节点同一会话）。
   * 为真时「使用 agent」是幂等操作，按钮按已用态呈现（spec 02「选中态工具栏」）。
   */
  alreadyInSession: boolean;
  /**
   * 处于容器形态（有成员）的选中 Agent 节点 id。「解散」仅对容器形态可用
   *（AG-CT-010：无成员已呈单节点形态、无组织关系可解除，不出现该项）。
   */
  dissolvableNodeIds: string[];
};

export type AgentNodeChromeProps = {
  /** 画布容器 ref（toolbar 绝对定位锚，与 MediaNodeChrome 同一定位口径） */
  canvasRef: React.RefObject<HTMLDivElement | null>;
};
