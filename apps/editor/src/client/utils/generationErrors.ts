import { isRecord, type UnknownRecord } from './typeGuards';
import { normalizeInternalBuildErrorMessage } from './internalBuildErrorMessages';

const readRecordValue = (record: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined ? descriptor.value : undefined;
};

// ============================================================================
// 错误分类类型定义
// ============================================================================

/**
 * 错误分类结果：用于区分不同类型的 API 错误并提取关键信息
 */
export type ErrorClassification =
  | { type: 'quota_insufficient'; userQuota: number; needQuota: number; rawMessage: string }
  | { type: 'content_blocked'; rawMessage: string }
  | { type: 'empty_response'; rawMessage: string }
  | { type: 'rate_limited'; rawMessage: string }
  | { type: 'unauthorized'; rawMessage: string }
  | { type: 'server_error'; status: number; rawMessage: string }
  | { type: 'network_error'; rawMessage: string }
  | { type: 'unknown'; rawMessage: string };

/**
 * 额度详情：从错误消息中提取的配额信息
 */
export interface QuotaDetails {
  userQuota: number | undefined;
  needQuota: number | undefined;
}

// ============================================================================
// 错误翻译规则（可扩展字典）
// ============================================================================

/**
 * 说明：
 * - 这里的“字典”不是简单的 code=>message，而是允许用 status/code/message 的组合做匹配。
 * - 在 Hub 后端 Task 模式下，error.message 往往是 "HTTP 500" 这种占位文本，真实原因在
 *   response.body 中；因此以 rawMessage/bodyStr 做模式匹配更稳妥。
 */
const UNSUPPORTED_MIME_TYPE_REGEX = /unsupported\s+mime\s+type:\s*([^\s]+)\s*/i;

const translateUnsupportedMimeTypeMessage = (message: string): string | null => {
  const match = message.match(UNSUPPORTED_MIME_TYPE_REGEX);
  if (!match) return null;
  const mimeType = match[1] !== null && match[1] !== undefined ? match[1].trim() : undefined;
  if (!mimeType) return null;
  return `这张图片的格式不支持，请换成 JPG、PNG 等常见格式后重试`;
};

const translateKnownErrorMessage = (message: string): string =>
  translateUnsupportedMimeTypeMessage(message) ?? message;

const MAX_USER_FACING_ERROR_MESSAGE_LENGTH = 2000;

const CONTENT_BLOCKED_PATTERNS = [
  // Google/Gemini 安全策略拦截
  'prohibited_content',
  'request_body_blocked',
  'request blocked by google gemini',
  'blocked by google gemini',
  'content is prohibited',
  // OpenAI/兼容接口常见：安全系统拒绝（有些上游会错误地返回 429）
  'rejected as a result of our safety system',
  'not allowed by our safety system',
] as const;

const EMPTY_RESPONSE_PATTERNS = [
  // 代理侧常见：Gemini 未返回有效 candidates（有时是输出被过滤、或链路异常）
  'empty_response',
  'received empty response from gemini',
  'no meaningful content in candidates',
] as const;

const INVALID_REQUEST_PATTERNS = [
  // 某些上游/代理会把 4xx 错误包装成 429；需要优先识别并避免误判为 rate_limited
  'unsupported mime type',
] as const;

const NETWORK_ERROR_PATTERNS = [
  'network',
  'timeout',
  'fetch',
  'terminated',
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'socket hang up',
] as const;

const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return '';
  }
};

const includesAny = (text: string, patterns: readonly string[]): boolean => {
  if (!text) return false;
  for (const pattern of patterns) {
    if (!pattern) continue;
    if (text.includes(pattern)) return true;
  }
  return false;
};

// ============================================================================ 
// 错误识别函数
// ============================================================================ 

/**
 * 检测错误是否为额度不足类型
 * 识别模式：
 * - error.code 包含 'insufficient_quota'
 * - error.message 包含 'quota' 相关关键词
 */
export const isQuotaInsufficientError = (error: unknown): boolean => {
  if (error == null) return false;

  // 递归搜索 error 对象中的关键字段
  const searchInObject = (obj: unknown, depth = 0): boolean => {
    if (depth > 5 || obj == null) return false;

    if (typeof obj === 'string') {
      const lower = obj.toLowerCase();
      // 英文配额错误识别
      const isEnglishQuotaError =
        lower.includes('insufficient_quota') ||
        lower.includes('quota failed') ||
        lower.includes('quota exceeded') ||
        (lower.includes('quota') && lower.includes('insufficient'));
      if (isEnglishQuotaError) return true;

      // 中文配额/余额不足错误识别
      const isChineseQuotaError =
        obj.includes('配额不足') ||
        obj.includes('余额不足') ||
        obj.includes('额度不足') ||
        obj.includes('账户余额') ||
        obj.includes('账号余额');
      if (isChineseQuotaError) return true;

      return false;
    }

    if (!isRecord(obj)) return false;

    // 检查 code 字段
    const code = readRecordValue(obj, 'code');
    if (typeof code === 'string') {
      const codeLower = code.toLowerCase();
      if (codeLower.includes('insufficient_quota') || codeLower.includes('quota_exceeded')) {
        return true;
      }
    }

    // 检查 type 字段
    const type = readRecordValue(obj, 'type');
    if (typeof type === 'string' && type.toLowerCase().includes('quota')) {
      return true;
    }

    // 检查 message 字段
    const message = readRecordValue(obj, 'message');
    if (typeof message === 'string') {
      const msgLower = message.toLowerCase();
      // 英文配额错误
      if (
        msgLower.includes('insufficient_quota') ||
        msgLower.includes('quota failed') ||
        (msgLower.includes('user quota') && msgLower.includes('need quota'))
      ) {
        return true;
      }
      // 中文配额/余额不足错误
      if (
        message.includes('配额不足') ||
        message.includes('余额不足') ||
        message.includes('额度不足') ||
        message.includes('账户余额') ||
        message.includes('账号余额')
      ) {
        return true;
      }
    }

    // 递归检查嵌套对象
    const nestedKeys = ['error', 'body', 'data', 'response', 'details'] as const;
    for (const key of nestedKeys) {
      if (key in obj && searchInObject(obj[key], depth + 1)) {
        return true;
      }
    }

    return false;
  };

  return searchInObject(error);
};

/**
 * 从错误消息中提取额度详情
 * 解析模式：'user quota: $X.XX, need quota: $Y.YY'
 */
export const extractQuotaDetails = (error: unknown): QuotaDetails => {
  const result: QuotaDetails = { userQuota: undefined, needQuota: undefined };
  if (error == null) return result;

  // 提取消息文本
  const message = extractErrorMessage(error);
  if (!message) return result;

  // 匹配 'user quota: $0.200000' 或 'user quota: ＄0.200000'（全角美元符号）
  const userQuotaMatch = message.match(/user\s*quota[:\s]*[$＄]?([\d.]+)/i);
  const userQuotaValue = (userQuotaMatch !== null && userQuotaMatch !== undefined ? userQuotaMatch[1] : undefined);
  if (userQuotaValue) {
    const parsed = parseFloat(userQuotaValue);
    if (!isNaN(parsed)) {
      result.userQuota = parsed;
    }
  }

  // 匹配 'need quota: $0.318000' 或 'need quota: ＄0.318000'
  const needQuotaMatch = message.match(/need\s*quota[:\s]*[$＄]?([\d.]+)/i);
  const needQuotaValue = (needQuotaMatch !== null && needQuotaMatch !== undefined ? needQuotaMatch[1] : undefined);
  if (needQuotaValue) {
    const parsed = parseFloat(needQuotaValue);
    if (!isNaN(parsed)) {
      result.needQuota = parsed;
    }
  }

  return result;
};

/**
 * 统一错误分类函数
 * 根据错误类型返回结构化的分类结果，便于 UI 层做差异化处理
 */
export const classifyError = (error: unknown): ErrorClassification => {
  const rawMessage = extractErrorMessage(error) ?? 'Unknown error';
  const normalizedMessage = rawMessage.toLowerCase();

  const status = isRecord(error) ? (error as { status: number | undefined }).status : undefined;
  const bodyStr = (() => {
    if (!isRecord(error)) return '';
    const body = (error as { body: unknown | undefined }).body;
    return typeof body === 'string' ? body : safeJsonStringify(body ?? '');
  })();
  const normalizedCombined = `${normalizedMessage}\n${bodyStr.toLowerCase()}`;

  // 1. 检测额度不足
  if (isQuotaInsufficientError(error)) {
    const { userQuota, needQuota } = extractQuotaDetails(error);
    return {
      type: 'quota_insufficient',
      userQuota: userQuota ?? 0,
      needQuota: needQuota ?? 0,
      rawMessage,
    };
  }

  // 2. 内容安全/策略拦截（请求被阻止）
  if (includesAny(normalizedCombined, CONTENT_BLOCKED_PATTERNS)) {
    return { type: 'content_blocked', rawMessage };
  }

  // 3. 空响应/无候选（常见于输出被过滤、或链路异常导致无有效内容）
  if (includesAny(normalizedCombined, EMPTY_RESPONSE_PATTERNS)) {
    return { type: 'empty_response', rawMessage };
  }

  // 4. 明确的请求参数错误（避免误判为 rate_limited）
  if (includesAny(normalizedCombined, INVALID_REQUEST_PATTERNS)) {
    return { type: 'unknown', rawMessage };
  }

  // 5. 检测速率限制 (429)
  if (
    status === 429 ||
    normalizedCombined.includes('resource_exhausted') ||
    normalizedCombined.includes('rate_limit') ||
    normalizedMessage.includes('rate limit')
  ) {
    return { type: 'rate_limited', rawMessage };
  }

  // 6. 检测未授权
  if (
    status === 401 ||
    status === 403 ||
    normalizedMessage.includes('unauthorized') ||
    normalizedMessage.includes('forbidden')
  ) {
    return { type: 'unauthorized', rawMessage };
  }

  // 7. 检测服务器错误
  if (typeof status === 'number' && status >= 500) {
    return { type: 'server_error', status, rawMessage };
  }

  // 8. 检测网络错误
  if (NETWORK_ERROR_PATTERNS.some(p => normalizedMessage.includes(p))) {
    return { type: 'network_error', rawMessage };
  }

  // 9. 未知错误
  return { type: 'unknown', rawMessage };
};

// ============================================================================
// 原有错误提取逻辑
// ============================================================================

const ERROR_FIELD_KEYS = [
  'error',
  'message',
  'msg',
  'detail',
  'description',
  'error_message',
  'errorMessage',
  'error_msg',
  'errorDescription',
  'reason',
  'cause',
] as const;

const ERROR_CONTAINER_KEYS = [
  'body',
  'data',
  'response',
  'details',
  'errorDetails',
  'error_details',
  'errorInfo',
  'info',
  'errors',
] as const;

const extractMessageFromUnknown = (value: unknown, visited: Set<unknown>): string | null => {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const firstChar = trimmed.charAt(0);
    const lastChar = trimmed.charAt(trimmed.length - 1);
    if (
      (firstChar === '{' && lastChar === '}') ||
      (firstChar === '[' && lastChar === ']')
    ) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const nested = extractMessageFromUnknown(parsed, visited);
        if (nested) {
          return nested;
        }
      } catch {
        // 忽略 JSON 解析错误，返回原始字符串
      }
    }
    return trimmed;
  }

  if (value instanceof Error) {
    const message = typeof value.message === 'string' ? value.message.trim() : '';
    return message ? message : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (visited.has(value)) {
    return null;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractMessageFromUnknown(item, visited);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  const record = value as UnknownRecord;
  for (const key of ERROR_FIELD_KEYS) {
    if (key in record) {
      const nested = extractMessageFromUnknown(record[key], visited);
      if (nested) {
        return nested;
      }
    }
  }

  for (const key of ERROR_CONTAINER_KEYS) {
    if (key in record) {
      const nested = extractMessageFromUnknown(record[key], visited);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
};

/**
 * 尽可能从未知错误对象中提取用户可读的信息。
 */
export const extractErrorMessage = (error: unknown): string | null => {
  if (error == null) {
    return null;
  }

  const visited = new Set<unknown>();
  if (isRecord(error)) {
    for (const key of ['body', 'data', 'response'] as const) {
      if (key in error) {
        const nested = extractMessageFromUnknown((error as UnknownRecord)[key], visited);
        if (nested) {
          return translateKnownErrorMessage(nested);
        }
      }
    }
  }

  const message = extractMessageFromUnknown(error, visited);
  return message ? translateKnownErrorMessage(message) : null;
};

const extractMessageFromMapLikeString = (message: string): string | null => {
  if (!message) return null;
  const mapStart = message.toLowerCase().indexOf('map[');
  if (mapStart === -1) return null;

  const mapEnd = message.indexOf(']', mapStart);
  const content = (mapEnd === -1 ? message.slice(mapStart + 4) : message.slice(mapStart + 4, mapEnd)).trim();
  if (!content) return null;

  const match = content.match(/(?:^|\s)(?:message|msg):(.+?)(?=(?:\s+[a-zA-Z_][\w-]*:)|$)/i);
  if (!match) return null;

  const extracted = match[1] !== null && match[1] !== undefined ? match[1].trim() : undefined;
  if (!extracted) return null;
  return extracted.replace(/^(["'])|(["'])$/g, '').trim() || null;
};

export const normalizeUserFacingErrorMessage = (
  message: string | null,
  friendly: string | undefined
): string | undefined => {
  if (!message) return undefined;

  let trimmed = message.trim();
  if (!trimmed) return undefined;
  if (friendly && trimmed === friendly.trim()) return undefined;

  const extracted = extractMessageFromMapLikeString(trimmed);
  if (extracted) {
    trimmed = extracted;
  }

  const internalBuildMessage = normalizeInternalBuildErrorMessage(trimmed);
  if (internalBuildMessage) return internalBuildMessage;

  // 仅在 message 完全等于 "HTTP 500" / "Request failed with status code 500" 这类占位文本时过滤；
  // 若包含更具体信息（如 "HTTP 500: Database connection failed"）则保留。
  if (/^HTTP\s*\d{3}$/i.test(trimmed)) return undefined;
  if (/^Request failed with status code\s*\d{3}$/i.test(trimmed)) return undefined;
  if (/^Unknown error$/i.test(trimmed)) return undefined;

  return trimmed.length > MAX_USER_FACING_ERROR_MESSAGE_LENGTH
    ? `${trimmed.slice(0, MAX_USER_FACING_ERROR_MESSAGE_LENGTH)}…`
    : trimmed;
};

export const extractUserFacingErrorMessage = (error: unknown, friendly: string | undefined): string | undefined =>
  normalizeUserFacingErrorMessage(extractErrorMessage(error), friendly);

const parseErrorPayload = (value: unknown): unknown => {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const firstChar = trimmed.charAt(0);
    const lastChar = trimmed.charAt(trimmed.length - 1);
    if (
      (firstChar === '{' && lastChar === '}') ||
      (firstChar === '[' && lastChar === ']')
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // 忽略解析失败，回退为原始字符串
      }
    }
    return trimmed;
  }
  return value;
};

/**
 * 尽量提取错误对象中的原始响应内容，便于历史记录持久化。
 */
export const extractErrorPayload = (error: unknown): unknown => {
  if (error == null) {
    return undefined;
  }

  if (isRecord(error)) {
    const directKeys = ['body', 'data', 'raw', 'payload'] as const;
    for (const key of directKeys) {
      if (key in error) {
        const candidate = parseErrorPayload((error as UnknownRecord)[key]);
        if (candidate !== undefined) {
          return candidate;
        }
      }
    }

    if ('response' in error) {
      const responseVal = readRecordValue(error, 'response');
      if (isRecord(responseVal)) {
        const nestedKeys = ['data', 'body', 'raw'] as const;
        for (const key of nestedKeys) {
          if (key in responseVal) {
            const nestedCandidate = parseErrorPayload((responseVal as UnknownRecord)[key]);
            if (nestedCandidate !== undefined) {
              return nestedCandidate;
            }
          }
        }
      }
      const normalizedResponse = parseErrorPayload(responseVal);
      if (normalizedResponse !== undefined) {
        return normalizedResponse;
      }
    }
  }

  return parseErrorPayload(error);
};

/**
 * 记录网络错误详情，方便调试定位。
 */
export const logNetworkError = (detail: string | null, fallback: unknown) => {
  if (detail && detail.trim()) {
    console.warn('[generation] network error:', detail);
    return;
  }
  if (fallback instanceof Error && typeof fallback.message === 'string') {
    console.warn('[generation] network error:', fallback.message, fallback);
    return;
  }
  console.warn('[generation] network error:', fallback);
};
