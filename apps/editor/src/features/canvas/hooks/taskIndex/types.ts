import type {
  RuntimeMediaAssetView,
  RuntimeTaskOutputRow,
  RuntimeTaskView,
} from "@iart/contracts";
import type { UnifiedGenerationOutputEntry } from "@iart/contracts/unified-generation";
import type {
  AudioInputNodeData,
  GraphNodeData,
  ImageInputNodeData,
  ModelNodeData,
  NodeTaskInfo,
  TextInputNodeData,
  VideoInputNodeData,
} from "../../types/node";

export type RuntimeTaskCanvasOutput = {
  outputIndex: number;
  entry: UnifiedGenerationOutputEntry;
};

export type RuntimeTaskCanvasProjection = {
  task: RuntimeTaskView;
  outputs: RuntimeTaskOutputRow[];
  mediaAssets: RuntimeMediaAssetView[];
};

export type DerivedTaskOutputRef = {
  parentNodeId: string;
  outputIndex: number;
};

export type TaskIndexNodeDataProjection = {
  label: unknown | undefined;
  runtimeRef: unknown | undefined;
  taskInfo: NodeTaskInfo | undefined;
  valueSource: unknown | undefined;
  imageUrl: unknown | undefined;
  imageMeta: unknown | undefined;
  videoUrl: unknown | undefined;
  videoMeta: unknown | undefined;
  audioUrl: unknown | undefined;
  __taskOutput: unknown | undefined;
};

export type DerivedMaterialNodePatch = {
  label: string | undefined;
  imageUrl: string | undefined;
  imageMeta: null | undefined;
  videoUrl: string | undefined;
  videoMeta: null | undefined;
  audioUrl: string | undefined;
  valueSource: "upstream";
  taskInfo: NodeTaskInfo | undefined;
  __taskOutput: DerivedTaskOutputRef & { source: "task-index" };
};

export type AsyncLifecycleNodePatch = Partial<
  Pick<ModelNodeData, "taskInfo" | "runtimeRef">
> &
  Partial<Pick<TextInputNodeData, "segments">> &
  Partial<Pick<ImageInputNodeData, "imageUrl" | "imageMeta">> &
  Partial<Pick<VideoInputNodeData, "videoUrl" | "videoMeta">> &
  Partial<Pick<AudioInputNodeData, "audioUrl">>;

export type CanvasNodeUpdate = {
  id: string;
  data: Partial<GraphNodeData> | AsyncLifecycleNodePatch;
};

export type CanvasTaskSyncStatusLevel =
  | "idle"
  | "connecting"
  | "connected"
  | "error";

export type CanvasTaskSyncStatus = {
  level: CanvasTaskSyncStatusLevel;
  code: string | null;
  message: string | null;
  wsEventType: "canvas_task_error" | null | undefined;
};

export type UseCanvasTaskIndexSyncOptions = {
  enabled: boolean | undefined;
  connectTimeoutMs: number | undefined;
  onStatusChange: (status: CanvasTaskSyncStatus) => void | undefined;
};

export const IDLE_STATUS: CanvasTaskSyncStatus = {
  level: "idle",
  code: null,
  message: null,
  wsEventType: null,
};
export const VIA_TASK_INDEX_SYNC = "task-index-sync";

export type DerivedMaterialOutput = {
  mediaType: "image" | "video" | "audio";
  url: string;
  outputIndex: number;
};
