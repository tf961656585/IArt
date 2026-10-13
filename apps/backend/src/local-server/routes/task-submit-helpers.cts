import type { FormalTaskSubmitOptions, TaskSubmissionResult } from "../business-actions.cts";
import { cloneJsonValue as cloneContractJsonValue, TaskSubmitRequestBodySchema } from "@iart/contracts";
import * as loggingModule from '../logging.cts';
import * as backendIpcSenderModule from "../backend-ipc-sender.cts";
import * as businessActionsModule from "../business-actions.cts";
import * as constantsModule from "../constants.cts";
import * as httpUtilsModule from "../http-utils.cts";
import type { HeadersRecord, RouteDefinition } from "../http/route-registry.cts";
import * as errorsModule from "../errors.cts";
import * as requestAssemblerModule from "../request-assembler.cts";
import type { AssemblerContext } from "../request-assembler-shared.cts";

type TaskAckLike = { taskId: unknown | undefined };
type AssembledTaskLike = { executionPlan: unknown | undefined };
type TasksReadResultLike = { success: unknown | undefined; data: unknown | undefined; error: unknown | undefined };
type TaskRecordLike = {
  taskId: unknown | undefined;
  projectPath: unknown | undefined;
  sourceNodeId: unknown | undefined;
  targetNodeId: unknown | undefined;
  remoteRequestId: unknown | undefined;
  status: unknown | undefined;
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
  errorMessage: unknown | undefined;
};
type TaskSubmitMetadataLike = {
  projectPath: unknown | undefined;
  nodeGraphId: unknown | undefined;
  sourceNodeId: unknown | undefined;
  targetNodeId: unknown | undefined;
  executionId: unknown | undefined;
  modelId: unknown | undefined;
  clientTaskRef: unknown | undefined;
  taskIndex: unknown | undefined;
  until_x_success_enabled: unknown | undefined;
  untilXSuccessEnabled: unknown | undefined;
  batch_id: unknown | undefined;
  batchId: unknown | undefined;
  target_success_count: unknown | undefined;
  targetSuccessCount: unknown | undefined;
  policyTierKey: unknown | undefined;
};
type TaskSubmitBodyLike = TaskSubmitMetadataLike & {
  model_id: unknown | undefined;
  prebuilt_payload: unknown | undefined;
  arguments: unknown | undefined;
  media_inputs: unknown | undefined;
  input_assets: unknown | undefined;
  metadata: unknown | undefined;
  path: unknown | undefined;
  batch_id: unknown | undefined;
  batchId: unknown | undefined;
  append_count: unknown | undefined;
  mention_map: unknown | undefined;
};
type FormalTaskMetadata = TaskSubmitMetadataLike & {
  until_x_success_enabled: unknown | undefined;
  batch_id: unknown | undefined;
  target_success_count: unknown | undefined;
  targetSuccessCount: unknown | undefined;
  policyTierKey: unknown | undefined;
};
type FormalTaskExecutionPlan = {
  model_id: unknown | undefined;
  submit_request: unknown | undefined;
  submit_request_summary: unknown | undefined;
  request: unknown | undefined;
  payload: unknown | undefined;
  arguments: unknown | undefined;
  media_inputs: unknown | undefined;
  input_assets: unknown | undefined;
  polling_strategy: unknown | undefined;
  result_rule: unknown | undefined;
  result_acquisition_strategy: unknown | undefined;
  result_output_mapping: unknown | undefined;
  auto_start: unknown | undefined;
  autoStart: unknown | undefined;
  metadata: FormalTaskMetadata | undefined;
};
type TaskAssemblerArgsPayload = {
  model_id: string;
  arguments: unknown | undefined;
  media_inputs: unknown | undefined;
  input_assets: unknown | undefined;
  mention_map: unknown | undefined;
};
type TaskAssemblerPrebuiltPayload = { model_id: string; payload: unknown };
type RuntimeTaskSnapshotLike = {
  batchId: unknown | undefined;
  sourceNodeId: unknown | undefined;
  request: unknown | undefined;
  metadata: unknown | undefined;
  createdAt: unknown | undefined;
  updatedAt: unknown | undefined;
};
type TaskSubmitOptions = FormalTaskSubmitOptions & {
  submissionTransport: string;
  compatMode: string;
  preserveLegacyTaskId: boolean;
};
type TaskSubmissionParsed = {
  ok: boolean;
  code: string;
  message: string;
  taskId: string | null;
};

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;
const { sendReadTasks, sendRuntimeTransaction } = backendIpcSenderModule;
const { submitFormalTaskExecutionPlan, flushSubmittedTask } = businessActionsModule;
const { toCompatTaskAssembleErrorMessage } = errorsModule;
const { assembleExecutionPlanFromPrebuiltPayload, assembleGenerationTaskRequest } = requestAssemblerModule;

const isJsonObject = (value: unknown): value is object => Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeString = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");
const cloneJsonValue = <T,>(value: T): T => {
  if (value == null) return value;
  return cloneContractJsonValue(value);
};

const getTaskRecordLike = (value: unknown): TaskRecordLike | null => (isJsonObject(value) ? (value as TaskRecordLike) : null);
const getTaskSubmitBodyLike = (value: unknown): TaskSubmitBodyLike | null => {
  const parsed = TaskSubmitRequestBodySchema.safeParse(value);
  if (!parsed.success) {
    loggingModule.logDebug('[task-submit-helpers] getTaskSubmitBodyLike: TaskSubmitRequestBodySchema parse failed', { error: parsed.error.message });
    return null;
  }
  return parsed.data as TaskSubmitBodyLike;
};
const getTasksReadResultLike = (value: unknown): TasksReadResultLike | null => (isJsonObject(value) ? (value as TasksReadResultLike) : null);
const isTaskAckLike = (value: unknown): value is TaskAckLike => isJsonObject(value);
const isAssembledTaskLike = (value: unknown): value is AssembledTaskLike => isJsonObject(value);
const getRuntimeTaskSnapshotLike = (value: unknown): RuntimeTaskSnapshotLike | null => (isJsonObject(value) ? (value as RuntimeTaskSnapshotLike) : null);

const emptyFormalTaskMetadata = (): FormalTaskMetadata => ({
  projectPath: undefined,
  nodeGraphId: undefined,
  sourceNodeId: undefined,
  targetNodeId: undefined,
  executionId: undefined,
  modelId: undefined,
  clientTaskRef: undefined,
  taskIndex: undefined,
  until_x_success_enabled: undefined,
  untilXSuccessEnabled: undefined,
  batch_id: undefined,
  batchId: undefined,
  target_success_count: undefined,
  targetSuccessCount: undefined,
  policyTierKey: undefined,
});

const projectFormalTaskMetadata = (...sources: readonly unknown[]): FormalTaskMetadata => {
  const metadata = emptyFormalTaskMetadata();
  for (const value of sources) {
    if (!isJsonObject(value)) continue;
    const source = value as FormalTaskMetadata;
    if (source.projectPath !== undefined) metadata.projectPath = source.projectPath;
    if (source.nodeGraphId !== undefined) metadata.nodeGraphId = source.nodeGraphId;
    if (source.sourceNodeId !== undefined) metadata.sourceNodeId = source.sourceNodeId;
    if (source.targetNodeId !== undefined) metadata.targetNodeId = source.targetNodeId;
    if (source.executionId !== undefined) metadata.executionId = source.executionId;
    if (source.modelId !== undefined) metadata.modelId = source.modelId;
    if (source.clientTaskRef !== undefined) metadata.clientTaskRef = source.clientTaskRef;
    if (source.taskIndex !== undefined) metadata.taskIndex = source.taskIndex;
    if (source.until_x_success_enabled !== undefined) {
      metadata.until_x_success_enabled = source.until_x_success_enabled;
    }
    if (source.untilXSuccessEnabled !== undefined) metadata.untilXSuccessEnabled = source.untilXSuccessEnabled;
    if (source.batch_id !== undefined) metadata.batch_id = source.batch_id;
    if (source.batchId !== undefined) metadata.batchId = source.batchId;
    if (source.target_success_count !== undefined) metadata.target_success_count = source.target_success_count;
    if (source.targetSuccessCount !== undefined) metadata.targetSuccessCount = source.targetSuccessCount;
    if (source.policyTierKey !== undefined) metadata.policyTierKey = source.policyTierKey;
  }
  return metadata;
};

const emptyFormalTaskExecutionPlan = (): FormalTaskExecutionPlan => ({
  model_id: undefined,
  submit_request: undefined,
  submit_request_summary: undefined,
  request: undefined,
  payload: undefined,
  arguments: undefined,
  media_inputs: undefined,
  input_assets: undefined,
  polling_strategy: undefined,
  result_rule: undefined,
  result_acquisition_strategy: undefined,
  result_output_mapping: undefined,
  auto_start: undefined,
  autoStart: undefined,
  metadata: undefined,
});

const projectFormalTaskExecutionPlan = (value: unknown, metadata: FormalTaskMetadata | undefined): FormalTaskExecutionPlan => {
  if (!isJsonObject(value)) {
    const plan = emptyFormalTaskExecutionPlan();
    if (metadata) plan.metadata = metadata;
    return plan;
  }
  const source = value as FormalTaskExecutionPlan;
  const executionPlan = emptyFormalTaskExecutionPlan();
  if (source.model_id !== undefined) executionPlan.model_id = source.model_id;
  if (source.submit_request !== undefined) executionPlan.submit_request = source.submit_request;
  if (source.submit_request_summary !== undefined) {
    executionPlan.submit_request_summary = source.submit_request_summary;
  }
  if (source.request !== undefined) executionPlan.request = source.request;
  if (source.payload !== undefined) executionPlan.payload = source.payload;
  if (source.arguments !== undefined) executionPlan.arguments = source.arguments;
  if (source.media_inputs !== undefined) executionPlan.media_inputs = source.media_inputs;
  if (source.input_assets !== undefined) executionPlan.input_assets = source.input_assets;
  if (source.polling_strategy !== undefined) executionPlan.polling_strategy = source.polling_strategy;
  if (source.result_rule !== undefined) executionPlan.result_rule = source.result_rule;
  if (source.result_acquisition_strategy !== undefined) {
    executionPlan.result_acquisition_strategy = source.result_acquisition_strategy;
  }
  if (source.result_output_mapping !== undefined) {
    executionPlan.result_output_mapping = source.result_output_mapping;
  }
  if (source.auto_start !== undefined) executionPlan.auto_start = source.auto_start;
  if (source.autoStart !== undefined) executionPlan.autoStart = source.autoStart;
  executionPlan.metadata = metadata ?? projectFormalTaskMetadata(source.metadata);
  return executionPlan;
};

const assembleExecutionPlanFromPrebuiltPayloadSafe = (payload: TaskAssemblerPrebuiltPayload, context: AssemblerContext) =>
  assembleExecutionPlanFromPrebuiltPayload(payload, context);

const assembleGenerationTaskRequestSafe = (payload: TaskAssemblerArgsPayload, context: AssemblerContext) => assembleGenerationTaskRequest(payload, context);

const submitFormalTaskExecutionPlanSafe = (executionPlan: FormalTaskExecutionPlan, options: TaskSubmitOptions): Promise<TaskSubmissionResult> =>
  submitFormalTaskExecutionPlan(executionPlan, options);

const parseTaskSubmission = (submission: TaskSubmissionResult): TaskSubmissionParsed => {
  const ackRecord = submission.ok && isTaskAckLike(submission.ack) ? submission.ack : null;
  return {
    ok: submission.ok,
    code: submission.ok ? "" : submission.code,
    message: submission.ok ? "" : submission.message,
    taskId: normalizeString((ackRecord !== null && ackRecord !== undefined ? ackRecord.taskId : undefined)) || null,
  };
};

const getAssembledExecutionPlan = (assembled: unknown): FormalTaskExecutionPlan => {
  if (!isAssembledTaskLike(assembled)) return emptyFormalTaskExecutionPlan();
  return projectFormalTaskExecutionPlan(assembled.executionPlan, undefined);
};

const parseTaskIndex = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const parsePositiveInteger = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
};

const hasNonEmptyObject = (value: unknown): boolean =>
  isJsonObject(value) && Object.keys(value).length > 0;

const hasNonEmptyArray = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0;

const hasDirectAppendPayloadSource = (body: TaskSubmitBodyLike | null): boolean =>
  hasNonEmptyObject((body !== null && body !== undefined ? body.arguments : undefined)) ||
  hasNonEmptyArray((body !== null && body !== undefined ? body.media_inputs : undefined)) ||
  hasNonEmptyArray((body !== null && body !== undefined ? body.input_assets : undefined));

const buildTaskPassthroughMetadata = (body: TaskSubmitBodyLike | null, metadataInput: TaskSubmitMetadataLike) => ({
  projectPath: normalizeString((body !== null && body !== undefined ? body.projectPath : undefined)) || normalizeString(metadataInput.projectPath) || undefined,
  nodeGraphId: normalizeString((body !== null && body !== undefined ? body.nodeGraphId : undefined)) || normalizeString(metadataInput.nodeGraphId) || undefined,
  sourceNodeId: normalizeString((body !== null && body !== undefined ? body.sourceNodeId : undefined)) || normalizeString(metadataInput.sourceNodeId) || undefined,
  targetNodeId: normalizeString((body !== null && body !== undefined ? body.targetNodeId : undefined)) || normalizeString(metadataInput.targetNodeId) || undefined,
  executionId: normalizeString((body !== null && body !== undefined ? body.executionId : undefined)) || normalizeString(metadataInput.executionId) || undefined,
  modelId: normalizeString((body !== null && body !== undefined ? body.modelId : undefined)) || normalizeString(metadataInput.modelId) || undefined,
  clientTaskRef: normalizeString((body !== null && body !== undefined ? body.clientTaskRef : undefined)) || normalizeString(metadataInput.clientTaskRef) || undefined,
  taskIndex: parseTaskIndex((body !== null && body !== undefined ? body.taskIndex : undefined)) ?? parseTaskIndex(metadataInput.taskIndex),
  until_x_success_enabled: (body !== null && body !== undefined ? body.until_x_success_enabled : undefined) ?? metadataInput.until_x_success_enabled,
  batch_id: (body !== null && body !== undefined ? body.batch_id : undefined) ?? metadataInput.batch_id,
  target_success_count: (body !== null && body !== undefined ? body.target_success_count : undefined) ?? metadataInput.target_success_count,
  policyTierKey: normalizeString((body !== null && body !== undefined ? body.policyTierKey : undefined)) || normalizeString(metadataInput.policyTierKey) || undefined,
});

const submitExecutionPlanOrSendError = async (
  executionPlan: FormalTaskExecutionPlan,
  options: TaskSubmitOptions,
  res: Parameters<RouteDefinition["handle"]>[0]["res"],
  corsHeaders: HeadersRecord,
) => {
  try {
    return await submitFormalTaskExecutionPlanSafe(executionPlan, options);
  } catch (error) {
    sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, error instanceof Error ? error.message : String(error), corsHeaders);
    return null;
  }
};

export {
  type TaskAckLike,
  type AssembledTaskLike,
  type TasksReadResultLike,
  type TaskRecordLike,
  type TaskSubmitMetadataLike,
  type TaskSubmitBodyLike,
  type FormalTaskMetadata,
  type FormalTaskExecutionPlan,
  type TaskAssemblerArgsPayload,
  type TaskAssemblerPrebuiltPayload,
  type AssemblerContext,
  type RuntimeTaskSnapshotLike,
  type TaskSubmitOptions,
  type TaskSubmissionParsed,
  isJsonObject,
  normalizeString,
  cloneJsonValue,
  getTaskRecordLike,
  getTaskSubmitBodyLike,
  getTasksReadResultLike,
  isTaskAckLike,
  isAssembledTaskLike,
  getRuntimeTaskSnapshotLike,
  projectFormalTaskMetadata,
  projectFormalTaskExecutionPlan,
  parseTaskIndex,
  parsePositiveInteger,
  hasNonEmptyObject,
  hasNonEmptyArray,
  hasDirectAppendPayloadSource,
  getAssembledExecutionPlan,
  parseTaskSubmission,
  buildTaskPassthroughMetadata,
  submitExecutionPlanOrSendError,
  assembleExecutionPlanFromPrebuiltPayloadSafe,
  assembleGenerationTaskRequestSafe,
  ERROR_CODES,
  sendJson,
  sendError,
  sendReadTasks,
  sendRuntimeTransaction,
  flushSubmittedTask,
  toCompatTaskAssembleErrorMessage,
};
