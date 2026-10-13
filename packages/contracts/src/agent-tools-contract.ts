/**
 * Agent Tools Contract
 *
 * agent 工具域共享叶子类型：工具类别、任务血缘、血缘 metadata 键。
 *
 * 语义事实源: docs/agent/04-执行管道与WS协议.md（工具集合投影、循环语义、血缘与画布投影）。
 *
 * 边界:
 * - 工具清单投影（名称/描述/参数 JSON Schema）是 Backend 单进程内对象（注册表 → chat-adapter），
 *   不跨 Electron 进程边界，归 Backend 内部类型，不入本契约。
 * - 工具调用 WS 事件、消息体与工具调用记录中的工具类别引用本文件的 `AgentToolKindSchema`。
 */

import * as z from 'zod';

// ────────────────────────────────────────────
// 1. 工具类别
// ────────────────────────────────────────────

/**
 * 工具类别（spec 04「工具集合投影」）：
 * - `generation`：生成工具（`generate_image` / `generate_video`），调用等价于一次标准生成主链派生。
 * - `processing`：加工工具（本地媒体处理固定注册表），不调远端模型、零计费。
 */
export const AGENT_TOOL_KINDS = ['generation', 'processing'] as const;

export const AgentToolKindSchema = z.enum(AGENT_TOOL_KINDS);

export type AgentToolKind = z.infer<typeof AgentToolKindSchema>;

// ────────────────────────────────────────────
// 2. 任务血缘
// ────────────────────────────────────────────

/**
 * agent 派生任务血缘（spec 04「血缘与画布投影」）。
 *
 * 写入位置：任务 `metadata[AGENT_TASK_LINEAGE_METADATA_KEY]`（任务 metadata 为既有 JSON 域）。
 * Editor 据此跳过画布任务节点投影；产物资产照常合并入项目资产库。
 */
export const AGENT_TASK_LINEAGE_METADATA_KEY = 'agentLineage';

export const AgentTaskLineageSchema = z.object({
  agentSessionId: z.string(),
  toolCallId: z.string(),
});

export type AgentTaskLineage = z.infer<typeof AgentTaskLineageSchema>;

// ────────────────────────────────────────────
// 3. 类型守卫
// ────────────────────────────────────────────

/** 从任务 metadata JSON 域中按共享键收窄血缘（不匹配返回 null，不做猜测）。 */
export function parseAgentTaskLineage(metadata: unknown): AgentTaskLineage | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value: unknown = Reflect.get(metadata, AGENT_TASK_LINEAGE_METADATA_KEY);
  const parsed = AgentTaskLineageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
