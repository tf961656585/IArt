"use client";

import { useCallback, useEffect, useState } from "react";
import type { TaskStateNotification, TaskStateSnapshot } from "@iart/contracts";
import {
  MediaAssetsChangedNotificationSchema,
  TaskStateNotificationSchema,
  TaskStateSnapshotSchema,
} from "@iart/contracts";
import { getRuntimeProjectPath } from "@/client/store/runtimeStore";
import {
  applyMediaAssetsChanged,
  applyTaskStateChanged,
  applyTaskStateSnapshot,
} from "@/features/promptdock/projection/taskProjectionService";
import type {
  CanvasTaskSyncStatus,
  UseCanvasTaskIndexSyncOptions,
} from "./taskIndex/types";
import { IDLE_STATUS } from "./taskIndex/types";

export type { CanvasTaskSyncStatus, CanvasTaskSyncStatusLevel } from "./taskIndex/types";

/**
 * 任务状态通知消费（Editor 新主链，Todo 6）。
 *
 * task:state-changed / task:state-snapshot / media-assets:changed 全部只 O(1) 更新既有
 * 任务/资产投影（features/promptdock/projection/taskProjectionService），绝不凭 taskId 建节点。
 * 旧补位协调器 / 结果区投影 / slot 反查链路已删除。
 */
export function useCanvasTaskIndexSync(
  nodeGraphId: string | null,
  options: UseCanvasTaskIndexSyncOptions | undefined,
): CanvasTaskSyncStatus {
  const enabled = (options !== null && options !== undefined ? options.enabled : undefined) ?? true;
  const onStatusChange = (options !== null && options !== undefined ? options.onStatusChange : undefined);
  const [status, setStatus] = useState<CanvasTaskSyncStatus>(IDLE_STATUS);

  const emitStatusChange = useCallback(
    (nextStatus: CanvasTaskSyncStatus): void => {
      if (onStatusChange) {
        onStatusChange(nextStatus);
      }
    },
    [onStatusChange],
  );

  useEffect(() => {
    const handleLegacyStatus = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as Partial<CanvasTaskSyncStatus>;
      if (detail.level !== "error") return;
      const nextStatus: CanvasTaskSyncStatus = {
        level: "error",
        code: typeof detail.code === "string" ? detail.code : "canvas_task_error",
        message: typeof detail.message === "string" ? detail.message : "canvas task error",
        wsEventType: detail.wsEventType === "canvas_task_error" ? "canvas_task_error" : null,
      };
      setStatus(nextStatus);
      emitStatusChange(nextStatus);
    };

    window.addEventListener("canvas-task-sync-status", handleLegacyStatus);
    return () => {
      window.removeEventListener("canvas-task-sync-status", handleLegacyStatus);
    };
  }, [emitStatusChange]);

  useEffect(() => {
    if (!enabled || !nodeGraphId) {
      setStatus(IDLE_STATUS);
      emitStatusChange(IDLE_STATUS);
      return;
    }

    const connectedStatus: CanvasTaskSyncStatus = {
      level: "connected",
      code: null,
      message: null,
      wsEventType: null,
    };
    setStatus(connectedStatus);
    emitStatusChange(connectedStatus);

    const handleTaskStateChanged = (message: unknown) => {
      let notification: TaskStateNotification;
      try {
        notification = TaskStateNotificationSchema.parse(message);
      } catch {
        console.warn("[useCanvasTaskIndexSync] invalid task:state-changed message", message);
        return;
      }
      applyTaskStateChanged(notification);
    };

    const handleTaskStateSnapshot = (message: unknown) => {
      let snapshot: TaskStateSnapshot;
      try {
        snapshot = TaskStateSnapshotSchema.parse(message);
      } catch {
        console.warn("[useCanvasTaskIndexSync] invalid task:state-snapshot message", message);
        return;
      }
      applyTaskStateSnapshot(snapshot);
    };

    const handleMediaAssetsChanged = (message: unknown) => {
      const notification = MediaAssetsChangedNotificationSchema.safeParse(message);
      if (!notification.success) {
        console.warn("[useCanvasTaskIndexSync] invalid media-assets:changed message", message);
        return;
      }
      const currentProjectPath = getRuntimeProjectPath();
      if (
        currentProjectPath &&
        notification.data.projectPath &&
        currentProjectPath !== notification.data.projectPath
      ) {
        return;
      }
      applyMediaAssetsChanged(notification.data);
    };

    if (window.electron !== null && window.electron !== undefined && window.electron.onTaskStateChanged) {
      window.electron.onTaskStateChanged(handleTaskStateChanged);
    }
    if (window.electron !== null && window.electron !== undefined && window.electron.onTaskStateSnapshot) {
      window.electron.onTaskStateSnapshot(handleTaskStateSnapshot);
    }
    if (window.electron !== null && window.electron !== undefined && window.electron.onMediaAssetsChanged) {
      window.electron.onMediaAssetsChanged(handleMediaAssetsChanged);
    }

    return () => {
      if (window.electron !== null && window.electron !== undefined && window.electron.removeTaskStateListeners) {
        window.electron.removeTaskStateListeners();
      }
    };
  }, [nodeGraphId, enabled, emitStatusChange]);

  return status;
}

export default useCanvasTaskIndexSync;
