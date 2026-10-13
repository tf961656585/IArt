'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';

import { resolveAgentFailureText } from '@/features/agent/agentErrorText';
import { useAgentSessionStore } from '@/features/agent/agentSessionStore';

/**
 * 一轮回复失败的一次性出口提示（挂载在右侧工作区容器：会话视图开没开都会提示）。
 *
 * - 受理之后的失败只进 store（会话视图里是一条错误条，用户可能没打开右栏），这里补一条 toast；
 * - 文案走错误码映射（`features/agent/agentErrorText`），界面不印后端原文；
 * - 以轮次标识做 toast id：同一次失败若提交路径也给出出口文案，覆盖同一条而不叠两条；
 * - 不自动重试、不提供重试入口：用户自行再发一条（重试入口属后续批次）。
 */
export function useAgentSessionErrorToast(): void {
  useEffect(() => {
    const unsubscribe = useAgentSessionStore.subscribe((state, prevState) => {
      for (const [agentSessionId, error] of Object.entries(state.errorsBySessionId)) {
        // 只在「该会话出现新的错误」时提示一次：同一条错误对象的重复通知不重复弹。
        if (prevState.errorsBySessionId[agentSessionId] === error) continue;
        console.debug('[rightWorkspace] agent round failed, toast once', {
          agentSessionId,
          code: error.code,
          requestId: error.requestId,
        });
        toast.error(resolveAgentFailureText(error.code), { id: error.requestId });
      }
    });
    return unsubscribe;
  }, []);
}

export default useAgentSessionErrorToast;
