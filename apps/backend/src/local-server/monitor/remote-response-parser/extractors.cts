const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const DEFAULT_TRY_PARSE_JSON_OPTIONS = { maxLength: undefined };

const tryParseJsonString = (value: unknown, options: { maxLength: number | undefined } = DEFAULT_TRY_PARSE_JSON_OPTIONS): unknown | null => {
  const optionMaxLength = options.maxLength;
  const maxLength = optionMaxLength !== undefined && Number.isFinite(optionMaxLength) ? optionMaxLength : 4096;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) return null;
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

type ResponseBodyLike = {
  request_id: unknown | undefined;
  requestId: unknown | undefined;
  task_id: unknown | undefined;
  taskId: unknown | undefined;
  id: unknown | undefined;
  status: unknown | undefined;
  state: unknown | undefined;
  task_status: unknown | undefined;
  taskStatus: unknown | undefined;
  progress: unknown | undefined;
  percent: unknown | undefined;
  percentage: unknown | undefined;
  output: ResponseBodyLike | undefined;
  data: ResponseBodyLike | undefined;
};

const asResponseBodyLike = (value: unknown): ResponseBodyLike | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as ResponseBodyLike;
};

const extractRequestIdFromBody = (body: unknown): string | null => {
  if (!body) return null;
  if (typeof body === 'string') {
    const parsed = tryParseJsonString(body);
    return parsed ? extractRequestIdFromBody(parsed) : null;
  }

  const record = asResponseBodyLike(body);
  if (!record) return null;
  const data = asResponseBodyLike(record.data);
  const nestedData = asResponseBodyLike((data !== null && data !== undefined ? data.data : undefined));
  const output = asResponseBodyLike(record.output);
  const candidates = [
    record.request_id,
    record.requestId,
    record.task_id,
    record.taskId,
    record.id,
    (output !== null && output !== undefined ? output.request_id : undefined),
    (output !== null && output !== undefined ? output.requestId : undefined),
    (output !== null && output !== undefined ? output.task_id : undefined),
    (output !== null && output !== undefined ? output.taskId : undefined),
    (output !== null && output !== undefined ? output.id : undefined),
    (data !== null && data !== undefined ? data.request_id : undefined),
    (data !== null && data !== undefined ? data.requestId : undefined),
    (data !== null && data !== undefined ? data.task_id : undefined),
    (data !== null && data !== undefined ? data.taskId : undefined),
    (data !== null && data !== undefined ? data.id : undefined),
    (nestedData !== null && nestedData !== undefined ? nestedData.request_id : undefined),
    (nestedData !== null && nestedData !== undefined ? nestedData.requestId : undefined),
    (nestedData !== null && nestedData !== undefined ? nestedData.task_id : undefined),
    (nestedData !== null && nestedData !== undefined ? nestedData.taskId : undefined),
    (nestedData !== null && nestedData !== undefined ? nestedData.id : undefined),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
};

const extractBodyStatus = (body: unknown): string => {
  if (!body) return '';
  if (typeof body === 'string') {
    const parsed = tryParseJsonString(body);
    return parsed ? extractBodyStatus(parsed) : '';
  }

  const record = asResponseBodyLike(body);
  if (!record) return '';
  const data = asResponseBodyLike(record.data);
  const nestedData = asResponseBodyLike((data !== null && data !== undefined ? data.data : undefined));
  const deeplyNestedData = asResponseBodyLike((nestedData !== null && nestedData !== undefined ? nestedData.data : undefined));
  const output = asResponseBodyLike(record.output);
  const candidates = [
    record.status,
    record.state,
    record.task_status,
    record.taskStatus,
    (output !== null && output !== undefined ? output.status : undefined),
    (output !== null && output !== undefined ? output.state : undefined),
    (output !== null && output !== undefined ? output.task_status : undefined),
    (output !== null && output !== undefined ? output.taskStatus : undefined),
    (data !== null && data !== undefined ? data.status : undefined),
    (data !== null && data !== undefined ? data.state : undefined),
    (data !== null && data !== undefined ? data.task_status : undefined),
    (data !== null && data !== undefined ? data.taskStatus : undefined),
    (nestedData !== null && nestedData !== undefined ? nestedData.status : undefined),
    (nestedData !== null && nestedData !== undefined ? nestedData.state : undefined),
    (nestedData !== null && nestedData !== undefined ? nestedData.task_status : undefined),
    (nestedData !== null && nestedData !== undefined ? nestedData.taskStatus : undefined),
    (deeplyNestedData !== null && deeplyNestedData !== undefined ? deeplyNestedData.status : undefined),
    (deeplyNestedData !== null && deeplyNestedData !== undefined ? deeplyNestedData.state : undefined),
    (deeplyNestedData !== null && deeplyNestedData !== undefined ? deeplyNestedData.task_status : undefined),
    (deeplyNestedData !== null && deeplyNestedData !== undefined ? deeplyNestedData.taskStatus : undefined),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeString(candidate).toLowerCase();
    if (normalized) return normalized;
  }
  return '';
};

const extractBodyProgress = (body: unknown): number | null => {
  if (!body) return null;
  if (typeof body === 'string') {
    const parsed = tryParseJsonString(body);
    return parsed ? extractBodyProgress(parsed) : null;
  }

  const record = asResponseBodyLike(body);
  if (!record) return null;
  const data = asResponseBodyLike(record.data);
  const nestedData = asResponseBodyLike((data !== null && data !== undefined ? data.data : undefined));
  const candidates = [
    record.progress,
    record.percent,
    record.percentage,
    (data !== null && data !== undefined ? data.progress : undefined),
    (data !== null && data !== undefined ? data.percent : undefined),
    (data !== null && data !== undefined ? data.percentage : undefined),
    (nestedData !== null && nestedData !== undefined ? nestedData.progress : undefined),
    (nestedData !== null && nestedData !== undefined ? nestedData.percent : undefined),
    (nestedData !== null && nestedData !== undefined ? nestedData.percentage : undefined),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      if (candidate < 0) continue;
      if (candidate <= 1) return candidate;
      if (candidate <= 100) return candidate / 100;
      continue;
    }
    const asText = normalizeString(candidate);
    if (!asText) continue;
    const parsed = Number.parseFloat(asText);
    if (!Number.isFinite(parsed) || parsed < 0) continue;
    if (parsed <= 1) return parsed;
    if (parsed <= 100) return parsed / 100;
  }
  return null;
};

export {
  normalizeString,
  extractRequestIdFromBody,
  extractBodyStatus,
  extractBodyProgress,
};
