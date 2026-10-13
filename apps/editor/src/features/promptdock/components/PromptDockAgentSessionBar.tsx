'use client';

import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import {
  useAgentSessionInFlight,
  useAgentSessionMeta,
} from '@/features/agent/agentSessionStore';
import { AGENT_NODE_LABEL } from '@/features/canvas/nodes/agent/agentNodeFactory';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { usePromptDockStore } from '../promptDockStore';

/**
 * agent 形态的会话绑定态（spec docs/agent/06「agent 形态的输入面」）。
 *
 * - 显示「<节点名> · <会话摘要>」+「新会话」；「新会话」只解绑，不改形态、不动草稿，
 *   此后发送会创建新的 Agent 节点（spec 06「形态切换入口」）。
 * - 会话数据读不到时（画布上有节点、会话记录缺失）如实说明，不让用户对着空标题发送。
 * - 在途时给一条紧附的进度提示；多轮历史的主承载仍是右侧工作区的会话视图，
 *   这里不展开成第二个聊天面板（spec 06「历史承载与会话视图」）。
 * - 动作不做说明文字：界面默认不印解释（docs/ui-copy-standard.md），动作名本身即口径。
 *   文案里不出现「绑定」「锚点」「session」等内部说法（spec 06「文案原则」）。
 */

/** 节点名兜底（节点已不在画布但绑定还在时）：与节点默认名同源，不另造别名。 */
const NODE_NAME_FALLBACK = AGENT_NODE_LABEL;

export function PromptDockAgentSessionBar() {
  const binding = usePromptDockStore((state) => state.agentBinding);
  const unbindAgentSession = usePromptDockStore((state) => state.unbindAgentSession);
  const agentSessionId = binding === null ? null : binding.agentSessionId;
  const nodeId = binding === null ? null : binding.nodeId;
  const session = useAgentSessionMeta(agentSessionId);
  const inFlight = useAgentSessionInFlight(agentSessionId);
  const nodeGraph = useCanvasStore((state) => state.nodeGraph);

  // 节点名取画布事实源（节点 data 的 label），不复制一份绑定态名称。
  const nodeName = useMemo(() => {
    if (nodeId === null) return NODE_NAME_FALLBACK;
    const node = nodeGraph?.nodes.find((candidate) => candidate.id === nodeId) ?? null;
    const label = node === null || node === undefined ? undefined : node.data.label;
    return typeof label === 'string' && label.length > 0 ? label : NODE_NAME_FALLBACK;
  }, [nodeGraph, nodeId]);

  if (binding === null) return null;

  return (
    <div
      className="dock-form-content flex min-w-0 items-center gap-2"
      data-testid="promptdock-agent-session-bar"
    >
      <span
        className="min-w-0 truncate text-xs text-muted-foreground"
        data-testid="promptdock-agent-session-summary"
      >
        {session === null ? '这个会话已经不在了' : `${nodeName} · ${session.title}`}
      </span>
      {inFlight === null ? null : (
        <span className="flex-none text-xs text-muted-foreground" data-testid="promptdock-agent-progress">
          正在回复…
        </span>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 flex-none px-2 text-xs"
        onClick={unbindAgentSession}
        data-testid="promptdock-agent-new-session"
      >
        新会话
      </Button>
    </div>
  );
}

export default PromptDockAgentSessionBar;
