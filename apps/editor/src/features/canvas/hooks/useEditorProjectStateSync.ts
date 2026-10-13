"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type EditorProjectStateSyncStatusLevel =
  | "idle"
  | "connecting"
  | "connected"
  | "error";

export type EditorProjectStateSyncStatus = {
  level: EditorProjectStateSyncStatusLevel;
  code: string | null;
  message: string | null;
  wsEventType: "editor_project_error" | null | undefined;
};

type UseEditorProjectStateSyncOptions = {
  enabled: boolean | undefined;
  connectTimeoutMs: number | undefined;
  onStatusChange: (status: EditorProjectStateSyncStatus) => void | undefined;
};

const IDLE_STATUS: EditorProjectStateSyncStatus = {
  level: "idle",
  code: null,
  message: null,
  wsEventType: null,
};

/**
 * 项目正式状态同步 hook。
 * P4 后 Storage Service 通过 IPC 工作，不再需要 WebSocket。
 * 保留此 hook 以兼容 CanvasEditor 的启动流程。
 */
export function useEditorProjectStateSync(
  _projectPath: string | null,
  options: UseEditorProjectStateSyncOptions | undefined,
): EditorProjectStateSyncStatus {
  const enabled = (options !== null && options !== undefined ? options.enabled : undefined) ?? true;
  const onStatusChange = (options !== null && options !== undefined ? options.onStatusChange : undefined);
  const [status, setStatus] =
    useState<EditorProjectStateSyncStatus>(IDLE_STATUS);
  // 用 ref 持有最新回调，保证 emitStatusChange 引用稳定：
  // 调用方传不稳定函数字面量时，避免 effect 反复重跑造成 setStatus → 重渲染 → 无限循环。
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);
  const emitStatusChange = useCallback(
    (nextStatus: EditorProjectStateSyncStatus): void => {
      const handler = onStatusChangeRef.current;
      if (handler) {
        handler(nextStatus);
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled) {
      setStatus(IDLE_STATUS);
      emitStatusChange(IDLE_STATUS);
      return;
    }

    const connectedStatus: EditorProjectStateSyncStatus = {
      level: "connected",
      code: "connected",
      message: "项目数据已准备好。",
      wsEventType: null,
    };
    setStatus(connectedStatus);
    emitStatusChange(connectedStatus);
  }, [enabled, emitStatusChange]);

  return status;
}

export default useEditorProjectStateSync;
