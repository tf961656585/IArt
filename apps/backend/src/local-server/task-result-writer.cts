const DEFAULT_TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
const DEFAULT_JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const DEFAULT_BINARY_CONTENT_TYPE = 'application/octet-stream';

const normalizeString = (value: unknown) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed ? trimmed : '';
};

type TaskResultResponseLike = {
  contentType: unknown | undefined;
  bodyType: unknown | undefined;
  file: {
    contentType: unknown | undefined;
  } | null | undefined;
};

type TaskResultRecordLike = {
  id: unknown | undefined;
};

const toResponseLike = (value: unknown): TaskResultResponseLike => {
  if (!value || typeof value !== 'object') return {} as TaskResultResponseLike;
  return value as TaskResultResponseLike;
};

const detectContentTypeForInlineBody = (response: unknown, body: unknown) => {
  const responseLike = toResponseLike(response);
  const declared = normalizeString(responseLike.contentType || (responseLike.file !== null && responseLike.file !== undefined ? responseLike.file.contentType : undefined));
  if (declared) return declared;
  if (responseLike.bodyType === 'json') return DEFAULT_JSON_CONTENT_TYPE;
  if (typeof body === 'object' && body !== null) return DEFAULT_JSON_CONTENT_TYPE;
  if (typeof body === 'string') return DEFAULT_TEXT_CONTENT_TYPE;
  return DEFAULT_BINARY_CONTENT_TYPE;
};

const detectContentTypeForFile = (response: unknown) => {
  const responseLike = toResponseLike(response);
  const declared = normalizeString(responseLike.contentType || (responseLike.file !== null && responseLike.file !== undefined ? responseLike.file.contentType : undefined));
  return declared || DEFAULT_BINARY_CONTENT_TYPE;
};

const ensureTaskResultFile = ({
  record,
  expectedPath,
  existingPath,
}: {
  record: unknown;
  expectedPath: string;
  existingPath: string;
}) => ({
  ok: false,
  code: 'task_result_file_deprecated',
  message: 'Task .result sidecar has been removed. Read task snapshot plus task archive instead.',
  taskId: normalizeString((record && typeof record === 'object' ? (record as TaskResultRecordLike).id : null)) || null,
  expectedPath: normalizeString(expectedPath) || null,
  existingPath: normalizeString(existingPath) || null,
});

export {
  ensureTaskResultFile,
  detectContentTypeForInlineBody,
  detectContentTypeForFile,
};
