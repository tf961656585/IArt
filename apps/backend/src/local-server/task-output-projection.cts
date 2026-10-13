import { sendReadTaskById } from './backend-ipc-sender.cts';
import { taskNotFound, taskExecutionFailed, toIsoTimestamp } from './errors.cts';
import { cloneJsonValue } from '@iart/contracts';

interface TaskMetadataRaw {
  modelId: unknown | undefined;
  remoteRequestId: unknown | undefined;
}

interface TaskRequestBodyRaw {
  model_id: unknown | undefined;
}

interface TaskRequestRaw {
  modelId: unknown | undefined;
  body: unknown | undefined;
}

interface TaskResponseRaw {
  outputs: unknown | undefined;
  remoteRequestId: unknown | undefined;
}

interface TaskRecordReadModel {
  status: unknown | undefined;
  metadata: unknown | undefined;
  request: unknown | undefined;
  response: unknown | undefined;
  progress: unknown | undefined;
  updatedAt: unknown | undefined;
  error: unknown | undefined;
}

interface PersistedOutputRaw {
  media_type: unknown | undefined;
  mime_type: unknown | undefined;
  text_value: unknown | undefined;
  asset_id: unknown | undefined;
  url: unknown | undefined;
  size_bytes: unknown | undefined;
}

interface TaskOutputPayload {
  media_type: string;
  asset_id: string | undefined;
  text_value: string | undefined;
  url: string | undefined;
  mime_type: string | undefined;
  size_bytes: number | undefined;
}

interface ReadSucceededOutputsInput {
  taskId: string;
  projectPath: string | null;
  response: unknown | undefined;
}

interface ProjectTaskReadModelOptions {
  projectPath: unknown | undefined;
}

const DEFAULT_PROJECT_TASK_READ_MODEL_OPTIONS: ProjectTaskReadModelOptions = {
  projectPath: undefined,
};

interface TaskReadProjection {
  task_id: string;
  status: string;
  model_id: string;
  progress: unknown | undefined;
  remote_request_id: string;
  outputs: TaskOutputPayload[];
  updated_at: string;
  error: unknown;
}

const normalizeString = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const isObjectLike = (value: unknown): value is object => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const asTaskRecordReadModel = (value: unknown): TaskRecordReadModel | null => {
  return isObjectLike(value) ? value as TaskRecordReadModel : null;
};

const asTaskMetadataRaw = (value: unknown): TaskMetadataRaw | null => {
  return isObjectLike(value) ? value as TaskMetadataRaw : null;
};

const asTaskRequestRaw = (value: unknown): TaskRequestRaw | null => {
  return isObjectLike(value) ? value as TaskRequestRaw : null;
};

const asTaskRequestBodyRaw = (value: unknown): TaskRequestBodyRaw | null => {
  return isObjectLike(value) ? value as TaskRequestBodyRaw : null;
};

const asTaskResponseRaw = (value: unknown): TaskResponseRaw | null => {
  return isObjectLike(value) ? value as TaskResponseRaw : null;
};

const asPersistedOutputRaw = (value: unknown): PersistedOutputRaw | null => {
  return isObjectLike(value) ? value as PersistedOutputRaw : null;
};

const cloneValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  return cloneJsonValue(value);
};

const inferMediaType = (entry: PersistedOutputRaw): string => {
  const explicit = normalizeString(entry.media_type);
  if (explicit) return explicit.toLowerCase();
  const mimeType = normalizeString(entry.mime_type).toLowerCase();
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (normalizeString(entry.text_value)) return 'text';
  return 'binary';
};

const mapPersistedOutput = (value: unknown): TaskOutputPayload | null => {
  const row = asPersistedOutputRaw(value);
  if (!row) return null;

  const mediaType = inferMediaType(row);
  if (!mediaType) return null;

  const payload = {
    media_type: mediaType,
    asset_id: undefined,
    text_value: undefined,
    url: undefined,
    mime_type: undefined,
    size_bytes: undefined,
  } as TaskOutputPayload;
  const assetId = normalizeString(row.asset_id);
  const textValue = normalizeString(row.text_value);
  const url = normalizeString(row.url);
  const mimeType = normalizeString(row.mime_type);
  if (assetId) payload.asset_id = assetId;
  if (textValue) payload.text_value = textValue;
  if (url) payload.url = url;
  if (mimeType) payload.mime_type = mimeType;
  if (typeof row.size_bytes === 'number' && Number.isFinite(row.size_bytes)) {
    payload.size_bytes = row.size_bytes;
  }
  return payload;
};

const isTaskOutputPayload = (value: TaskOutputPayload | null): value is TaskOutputPayload => value !== null;

const mapResponseOutputs = (response: unknown): TaskOutputPayload[] => {
  const responseRaw = asTaskResponseRaw(response);
  if (!responseRaw) return [];
  const outputs = Array.isArray(responseRaw.outputs) ? responseRaw.outputs : [];
  return (outputs as unknown[]).map(mapPersistedOutput).filter(isTaskOutputPayload);
};

const resolveRequestModelId = (request: unknown): string => {
  const requestRaw = asTaskRequestRaw(request);
  const bodyRaw = asTaskRequestBodyRaw((requestRaw !== null && requestRaw !== undefined ? requestRaw.body : undefined));
  return normalizeString((requestRaw !== null && requestRaw !== undefined ? requestRaw.modelId : undefined)) || normalizeString((bodyRaw !== null && bodyRaw !== undefined ? bodyRaw.model_id : undefined));
};

const resolveModelId = (record: TaskRecordReadModel): string => {
  const recordMetadata = asTaskMetadataRaw(record.metadata);
  return normalizeString((recordMetadata !== null && recordMetadata !== undefined ? recordMetadata.modelId : undefined)) || resolveRequestModelId(record.request);
};

const resolveRemoteRequestId = (record: TaskRecordReadModel): string => {
  const recordMetadata = asTaskMetadataRaw(record.metadata);
  const recordResponse = asTaskResponseRaw(record.response);
  return normalizeString((recordMetadata !== null && recordMetadata !== undefined ? recordMetadata.remoteRequestId : undefined)) || normalizeString((recordResponse !== null && recordResponse !== undefined ? recordResponse.remoteRequestId : undefined));
};

const resolveTaskError = (status: unknown, record: TaskRecordReadModel): unknown => {
  const rawError = isObjectLike(record.error) ? record.error : null;
  if (rawError) return rawError;
  if (normalizeString(status) === 'failed') {
    return taskExecutionFailed();
  }
  return null;
};

const readSucceededOutputs = ({ response }: ReadSucceededOutputsInput): TaskOutputPayload[] => {
  return mapResponseOutputs(response);
};

const projectTaskReadModel = async (
  taskId: string,
  options: ProjectTaskReadModelOptions = DEFAULT_PROJECT_TASK_READ_MODEL_OPTIONS,
): Promise<TaskReadProjection> => {
  const projectPath = normalizeString(options.projectPath) || '';
  let record: TaskRecordReadModel | null = null;
  const resolvedProjectPath = projectPath;
  try {
    const result = await sendReadTaskById({ projectPath, taskId });
    record = result.success ? asTaskRecordReadModel(result.data) : null;
  } catch {
    // ignore
  }
  if (!record) {
    throw taskNotFound(taskId);
  }

  const status = normalizeString(record.status);
  const outputs = status === 'succeeded'
    ? readSucceededOutputs({
        taskId,
        projectPath: resolvedProjectPath || null,
        response: record.response,
      })
    : [];
  return {
    task_id: taskId,
    status,
    model_id: resolveModelId(record),
    progress: isObjectLike(record.progress) ? cloneValue(record.progress) : undefined,
    remote_request_id: resolveRemoteRequestId(record),
    outputs,
    updated_at: toIsoTimestamp(record.updatedAt),
    error: resolveTaskError(status, record),
  };
};

export {
  projectTaskReadModel,
};
