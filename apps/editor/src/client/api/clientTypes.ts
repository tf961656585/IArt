
export interface ApiError {
  message: string;
  status: number | undefined;
  body: unknown | undefined;
}

export type ResponseTypeHint = 'auto' | 'json' | 'text' | 'blob' | 'arrayBuffer' | 'response';
export type StreamMode = 'disabled' | 'auto';

export type DynamicPayload = Record<string, unknown>;
export type DynamicMetadata = DynamicPayload;
export type DynamicParams = DynamicPayload;

export type TaskMetaKnownFields = {
  taskId: unknown | undefined;
  model: unknown | undefined;
  modelId: unknown | undefined;
  model_id: unknown | undefined;
  prompt: unknown | undefined;
  projectPath: unknown | undefined;
  nodeGraphId: unknown | undefined;
  scope: unknown | undefined;
  canvasPushManaged: unknown | undefined;
  appVersion: unknown | undefined;
  sourceNodeId: unknown | undefined;
  targetNodeId: unknown | undefined;
  executionId: unknown | undefined;
  until_x_success_enabled: unknown | undefined;
  batch_id: unknown | undefined;
  target_success_count: unknown | undefined;
};

type TaskMetadataKnownPatch = Partial<TaskMetaKnownFields>;
export type TaskMetadata = DynamicMetadata & TaskMetadataKnownPatch;
export type RequestHeadersInput = DynamicParams;

export type BackendTaskPendingResult = {
  __backend_task_pending: true;
  taskId: string | undefined;
};

type RequestOptionDefaults = {
  method: string | undefined;
  endpoint: string;
  headers: RequestHeadersInput | undefined;
  body: unknown | undefined;
  responseType: ResponseTypeHint | undefined;
  includeAuth: boolean | undefined;
  resolveEndpoint: boolean | undefined;
  cache: RequestCache | undefined;
  contentType: string | null | undefined;
  streamMode: StreamMode | undefined;
  onStream: (aggregated: string) => void | undefined;
  useBackendTask: boolean | undefined;
  taskMeta: TaskMetadata | undefined;
  onTaskAccepted: (taskId: string) => void | undefined;
};

export type RequestOptions = Pick<RequestOptionDefaults, 'endpoint'> &
  Partial<Omit<RequestOptionDefaults, 'endpoint'>>;

export const isApiError = (value: unknown): value is ApiError => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof (value as { message: unknown | undefined }).message === 'string'
  );
};

export const buildBackendTaskPendingResult = (taskId: string | undefined): BackendTaskPendingResult => ({
  __backend_task_pending: true,
  taskId,
});

export const asTypedValue = <T>(value: unknown): T => value as T;

type SubmitFormalCanvasTaskOptionDefaults = {
  modelId: string;
  payload: unknown | undefined;
  metadata: TaskMetadata | undefined;
  onTaskAccepted: (taskId: string) => void | undefined;
};

export type SubmitFormalCanvasTaskOptions =
  Pick<SubmitFormalCanvasTaskOptionDefaults, 'modelId' | 'payload' | 'metadata'> &
  Partial<Pick<SubmitFormalCanvasTaskOptionDefaults, 'onTaskAccepted'>> &
  Partial<{ /** 模型的 parameter_schema，用于基于字段语义识别媒体输入 */ parameterSchema: unknown }> &
  Partial<{ /** "@锚点 → 素材"映射（spec §7.2），后端据此为被 @的 referenceBlob 注入 mention */ mentionMap: Record<string, { media_kind: string; index: number }> }>;

export interface SubmitFormalCanvasTaskResult {
  __backend_task_pending: true;
  taskId: string;
  raw: unknown;
}
