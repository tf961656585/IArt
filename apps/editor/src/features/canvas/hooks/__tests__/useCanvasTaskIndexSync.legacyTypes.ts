import type { vi } from "vitest";
import type { RuntimeTaskView, MediaAsset } from "@iart/contracts";
import type { UnifiedGenerationStatus } from "@iart/contracts/unified-generation";

export type RuntimeRowStatus = RuntimeTaskView["status"];

export type LegacyTaskStatus = UnifiedGenerationStatus | RuntimeRowStatus | "running" | "generating";

export type LegacyUntilXBatch = {
  until_x_success_enabled?: boolean;
  batch_id?: string;
  target_success_count?: number;
  cancel_requested?: boolean;
  current_success_count?: number;
  in_flight_count?: number;
  main_display_results?: unknown[];
  batch_closed?: boolean;
  close_reason?: string | null;
};

export type LegacyIndexOutput = {
  mediaType?: string;
  assetId?: string | null;
  textValue?: string | null;
  url?: string | null;
  mediaAsset?: MediaAsset;
};

export type LegacyTaskEntry = {
  taskId: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  modelId?: string;
  executionId?: string;
  status?: LegacyTaskStatus;
  createdAt?: number;
  updatedAt?: number;
  progress?: { phase?: string | null } | null;
  error?: string;
  outputs?: LegacyIndexOutput[];
  until_x_batch?: LegacyUntilXBatch;
};

export type LegacyOutputBucket = {
  lastTaskId?: string;
  updatedAt?: number;
  outputs?: LegacyIndexOutput[];
};

export type LegacySourceTaskBucket = Record<string, LegacyTaskEntry>;

export type LegacyCanvasTaskSnapshotPayload = {
  type: "canvas_task_snapshot";
  index: {
    nodeGraphId?: string;
    updatedAt?: string;
    tasksById?: Record<string, LegacyTaskEntry>;
    outputsByNodeId?: Record<string, LegacyOutputBucket>;
    sourceTasksByNodeId?: Record<string, LegacySourceTaskBucket>;
  };
};

export type LegacyCanvasTaskDeltaPayload = {
  type: "canvas_task_delta";
  delta: {
    changedTasks?: Record<string, LegacyTaskEntry>;
    changedOutputs?: Record<string, LegacyOutputBucket>;
    tombstones?: Array<{ nodeId?: string }>;
  };
};

export type LegacyTaskDeltaPayload = {
  type: "task_delta";
  taskId: string;
  targetNodeId?: string;
  status?: LegacyTaskStatus;
  createdAt?: number;
  emittedAt?: number;
  outputs?: LegacyIndexOutput[];
};

export type LegacyCanvasTaskErrorPayload = {
  type: "canvas_task_error";
  code?: string;
  message?: string;
};

export type LegacySocketPayload =
  | LegacyCanvasTaskSnapshotPayload
  | LegacyCanvasTaskDeltaPayload
  | LegacyTaskDeltaPayload
  | LegacyCanvasTaskErrorPayload;

export type LegacyTaskIndexData = {
  version: number;
  nodeGraphId: string;
  updatedAt: string;
  tasksById: NonNullable<LegacyCanvasTaskSnapshotPayload["index"]["tasksById"]>;
  outputsByNodeId: NonNullable<LegacyCanvasTaskSnapshotPayload["index"]["outputsByNodeId"]>;
  sourceTasksByNodeId: NonNullable<LegacyCanvasTaskSnapshotPayload["index"]["sourceTasksByNodeId"]>;
};

export type TaskStateChangedHandler = (message: unknown) => void;
export type TaskStateSnapshotHandler = (message: unknown) => void;

export type ElectronTaskListenerMock = {
  onTaskStateChanged: ReturnType<typeof vi.fn<TaskStateChangedHandler>>;
  onTaskStateSnapshot: ReturnType<typeof vi.fn<TaskStateSnapshotHandler>>;
  removeTaskStateListeners: ReturnType<typeof vi.fn<() => void>>;
};
