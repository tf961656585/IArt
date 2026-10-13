import type { AgentSessionRecord } from '@iart/contracts';
import type { PromptDockAgentBinding, PromptDockAgentSelection } from './PromptDock.types';

/**
 * agent 形态会话绑定相关的纯函数（提交体构造与形态配置解析）。
 *
 * 真相归属（spec docs/agent/03-会话存储与IPC契约.md「会话归属」）：
 * - 绑定既有会话时，模型 / 思考 / 审批以**会话记录**为准——会话创建后模型不提供更换
 *   （要继续其他模型需另开 Agent 节点）；思考与审批可改并随会话持久化。
 * - 未绑定时用 agent 形态自身记得的选择（spec 06「形态切换入口」：每个形态独立记忆）。
 */

/**
 * 解析 agent 形态当前生效的形态配置。
 *
 * 绑定但会话记录尚未读到（会话数据缺失）时返回形态自身的选择——该情形由调用方
 * 按「会话不可用」阻断提交，不在此静默替用户换配置。
 */
export const resolveAgentFormSelection = (
  binding: PromptDockAgentBinding | null,
  session: AgentSessionRecord | null,
  formSelection: PromptDockAgentSelection,
): PromptDockAgentSelection => {
  if (binding === null || session === null) return formSelection;
  return {
    modelId: session.modelId,
    thinkingTier: session.thinkingTier,
    approval: session.approvalMode,
  };
};

/**
 * 一次提交的本地标识（请求标识 / 新会话标识）。
 * uuid 优先；运行环境不提供时回落到时间戳 + 随机串，仍保证不重复。
 */
export const createAgentLocalId = (): string => {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef !== undefined && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  return `agent_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};
