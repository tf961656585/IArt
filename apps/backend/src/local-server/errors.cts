/**
 * Protocol-level error types and helpers shared across the local server.
 */

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

export class ProtocolError extends Error {
  layer: string;
  code: string;
  httpStatus: number;

  constructor(layer: string, code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = 'ProtocolError';
    this.layer = layer;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const createProtocolError = (layer: string, code: string, message: string, httpStatus = 400) =>
  new ProtocolError(layer, code, message, httpStatus);

// --- Error factory functions ---

export const invalidArguments = (message = 'Invalid tool arguments') =>
  createProtocolError('request_error', 'REQUEST_INVALID_ARGUMENTS', message, 400);

export const mediaKindNotSupported = (message = 'Media kind not supported') =>
  createProtocolError('request_error', 'REQUEST_MEDIA_KIND_NOT_SUPPORTED', message, 400);

export const mediaSourceUnavailable = (message = 'Media source unavailable') =>
  createProtocolError('request_error', 'REQUEST_MEDIA_SOURCE_UNAVAILABLE', message, 400);

export const modelUnavailable = (modelId = '') =>
  createProtocolError(
    'request_error',
    'REQUEST_MODEL_UNAVAILABLE',
    modelId ? `Model unavailable: ${modelId}` : 'Model unavailable',
    404,
  );

export const taskNotFound = (taskId = '') =>
  createProtocolError(
    'request_error',
    'REQUEST_TASK_NOT_FOUND',
    taskId ? `Task not found: ${taskId}` : 'Task not found',
    404,
  );

export const taskExecutionFailed = (message = 'Task execution failed') => ({
  code: 'TASK_EXECUTION_FAILED',
  message,
});

// --- Type guards and normalization ---

export const isProtocolError = (error: unknown) => error instanceof ProtocolError;

export const ensureProtocolError = (error: unknown) => {
  if (error instanceof ProtocolError) return error;
  const message =
    error instanceof Error ? normalizeString(error.message) || error.name : normalizeString(error);
  return invalidArguments(message || 'Invalid tool arguments');
};

// --- Compat helpers ---

export const toCompatTaskAssembleErrorMessage = (
  error: unknown,
  fallbackMessage = 'Failed to assemble task request',
) => {
  const normalized = ensureProtocolError(error);
  const candidateMessage =
    normalizeString((normalized !== null && normalized !== undefined ? normalized.message : undefined)) ||
    normalizeString(error instanceof Error ? error.message : error);
  const sanitized = candidateMessage
    .replace(/\b\w*ProtocolError\w*\b\s*:?\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return sanitized || fallbackMessage;
};

// --- Utility ---

/**
 * Convert a value to an ISO timestamp string.
 */
export const toIsoTimestamp = (value: unknown): string => {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return new Date().toISOString();
};
