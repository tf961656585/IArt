type TaskMetadataView = {
  taskId: unknown | undefined;
  taskExecutionPlan: unknown | undefined;
};

type TaskExecutionPlanView = {
  result_acquisition_strategy: unknown | undefined;
  result_output_mapping: unknown | undefined;
};

type ResultOutputMappingView = {
  response_mode: unknown | undefined;
  download_required_condition: unknown | undefined;
  output_mapping_rules: unknown | undefined;
  note: unknown | undefined;
};

type TaskRecordView = {
  taskId: unknown | undefined;
  id: unknown | undefined;
  metadata: unknown | undefined;
  projectPath: unknown | undefined;
  status: unknown | undefined;
  request: unknown | undefined;
  response: unknown | undefined;
  progress: unknown | undefined;
};

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const isPlainObject = (value: unknown): value is object => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
};

const asTaskMetadataView = (value: unknown): TaskMetadataView =>
  isPlainObject(value) ? value as TaskMetadataView : {} as TaskMetadataView;

const asTaskExecutionPlanView = (value: unknown): TaskExecutionPlanView =>
  isPlainObject(value) ? value as TaskExecutionPlanView : {} as TaskExecutionPlanView;

const asResultOutputMappingView = (value: unknown): ResultOutputMappingView =>
  isPlainObject(value) ? value as ResultOutputMappingView : {} as ResultOutputMappingView;

const asTaskRecordView = (value: unknown): TaskRecordView =>
  isPlainObject(value) ? value as TaskRecordView : {} as TaskRecordView;

const readTaskRecordId = (taskRecordInput: unknown) => {
  const taskRecord = asTaskRecordView(taskRecordInput);
  const metadata = asTaskMetadataView(taskRecord.metadata);
  return normalizeString(taskRecord.taskId || taskRecord.id || metadata.taskId);
};

const readResultOutputMapping = (record: unknown): ResultOutputMappingView | null => {
  const taskRecord = asTaskRecordView(record);
  const metadata = asTaskMetadataView(taskRecord.metadata);
  const plan = asTaskExecutionPlanView(metadata.taskExecutionPlan);
  const mapping = asResultOutputMappingView(plan.result_output_mapping);
  return Object.keys(mapping).length > 0 ? mapping : null;
};

export {
  type ResultOutputMappingView,
  type TaskExecutionPlanView,
  type TaskMetadataView,
  type TaskRecordView,
  asTaskRecordView,
  readResultOutputMapping,
  readTaskRecordId,
};
