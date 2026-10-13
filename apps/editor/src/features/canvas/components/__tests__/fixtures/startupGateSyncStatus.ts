import type { CanvasTaskSyncStatus } from "../../../hooks/useCanvasTaskIndexSync";
import type { EditorProjectStateSyncStatus } from "../../../hooks/useEditorProjectStateSync";

export const createIdleCanvasTaskSyncStatus = (): CanvasTaskSyncStatus => ({
  level: "idle",
  code: null,
  message: null,
  wsEventType: null,
});

export const createConnectedCanvasTaskSyncStatus =
  (): CanvasTaskSyncStatus => ({
    level: "connected",
    code: "connected",
    message: "任务状态服务已连接。",
    wsEventType: null,
  });

export const createConnectedProjectStateSyncStatus =
  (): EditorProjectStateSyncStatus => ({
    level: "connected",
    code: "connected",
    message: "项目正式状态服务已连接。",
    wsEventType: null,
  });
