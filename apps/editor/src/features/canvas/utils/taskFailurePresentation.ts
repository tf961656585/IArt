import type { RuntimeTaskFailure } from "@iart/contracts";
import { normalizeUserFacingErrorMessage } from "@/client/utils/generationErrors";
import { getClientI18n } from "@/lib/i18n/client";
import type { NodeTaskInfo } from "../types/node";

export type TaskFailurePresentation = {
  title: string;
  summary: string;
  code: string | null;
  reasonTags: string[];
  retryable: boolean | null;
  backendMessage: string | null;
  rawDetailText: string | null;
  copyText: string;
};

type ResolveTaskFailurePresentationInput = {
  taskInfo: NodeTaskInfo | null | undefined | undefined;
  backendMessage: string | null | undefined | undefined;
  fallback: string | undefined;
};

type PlainObject = Record<string, unknown>;

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const isPlainObject = (value: unknown): value is PlainObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringifyDetail = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value === "string") return normalizeString(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const collectReasonTags = (value: unknown, tags = new Set<string>()): string[] => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && trimmed.length <= 80) tags.add(trimmed);
    return [...tags];
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReasonTags(item, tags);
    return [...tags];
  }
  if (!isPlainObject(value)) return [...tags];
  for (const key of ["failureReasons", "failure_reasons", "reasons", "reason", "labels", "label"]) {
    collectReasonTags(value[key], tags);
  }
  return [...tags];
};

// httpStatus 查表只对无信息量的兜底码生效。厂商明确语义码（如 moderation_blocked）即便携带
// 4xx/5xx 状态码也可能是借壳（内容审核拒绝复用 429），code 语义更可信，查表应让位于 message 链。
const GENERIC_CODES = new Set<string>(["task_execution_failed", ""]);

// 从 failure.details 防御性读取 httpStatus（details 可能是 null / 非对象 / 数组）。
const readHttpStatusFromDetails = (failure: RuntimeTaskFailure | null): number | null => {
  if (!failure) return null;
  const details = failure.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const raw = (details as PlainObject).httpStatus;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
};

// 按 details.httpStatus 查 i18n（451/409/422/429/5xx 区间），不依赖 message 子串。
const summarizeHttpStatusFailure = (failure: RuntimeTaskFailure | null): string | null => {
  if (!failure) return null;
  // 当 failure 带有厂商明确语义码（非兜底码）时，httpStatus 查表让位——
  // 状态码可能是厂商借壳（如内容审核拒绝复用 429），code 语义更可信。
  // 兜底码 task_execution_failed 无信息量，仍走 httpStatus 查表。
  const code = typeof failure.code === "string" ? failure.code.trim() : "";
  if (!GENERIC_CODES.has(code)) return null;

  const httpStatus = readHttpStatusFromDetails(failure);
  if (httpStatus === null) return null;
  const i18n = getClientI18n();
  const exactKey = `errors:httpStatus.${String(httpStatus)}`;
  // 缺失 key 时 i18next 默认返回 key 字符串本身；用 exists 判断避免误用。
  if (i18n.exists(exactKey)) return i18n.t(exactKey) as string;
  if (httpStatus >= 500 && httpStatus < 600) {
    const serverKey = "errors:httpStatus.5xx";
    if (i18n.exists(serverKey)) return i18n.t(serverKey) as string;
  }
  return null;
};

const summarizeKnownFailure = (
  failure: RuntimeTaskFailure | null,
  reasonTags: string[],
): string | null => {
  // 精确语义优先：code/reasonTags 是确定性内容安全语义，先于通用 httpStatus 查表。
  const code = normalizeString((failure !== null && failure !== undefined ? failure.code : undefined));
  if (code === "PUBLIC_ERROR_SEXUAL") return "内容安全策略拦截";
  if (reasonTags.map((tag) => tag.toUpperCase()).includes("NCII")) {
    return "内容安全策略拦截";
  }
  // 通用 httpStatus 查表（451/409/422/429/5xx）：精确语义之后的兜底，不依赖 message 子串。
  // 对厂商明确语义码（非兜底码）让位（见 summarizeHttpStatusFailure），避免状态码借壳错误归因。
  const httpStatusSummary = summarizeHttpStatusFailure(failure);
  if (httpStatusSummary !== null) return httpStatusSummary;
  return null;
};

const trimLongInlineSummary = (value: string): string => {
  if (value.length <= 140 && !value.includes("{")) return value;
  return `${value.slice(0, 137).trim()}...`;
};

export function resolveTaskFailurePresentation({
  taskInfo,
  backendMessage,
  fallback = "任务执行失败",
}: ResolveTaskFailurePresentationInput): TaskFailurePresentation | null {
  const failure = (taskInfo !== null && taskInfo !== undefined ? taskInfo.failure : undefined) ?? null;
  const legacyError = normalizeString((taskInfo !== null && taskInfo !== undefined ? taskInfo.error : undefined));
  const backendTexts = [
    normalizeString((failure !== null && failure !== undefined ? failure.backendMessage : undefined)),
    normalizeString(backendMessage),
  ].filter((item): item is string => Boolean(item));
  const backendText = [...new Set(backendTexts)].join("\n\n") || null;
  if (!failure && !legacyError && !backendText && (taskInfo !== null && taskInfo !== undefined ? taskInfo.status : undefined) !== "failed") return null;

  const reasonTags = collectReasonTags((failure !== null && failure !== undefined ? failure.details : undefined));
  const code = normalizeString((failure !== null && failure !== undefined ? failure.code : undefined));
  const knownSummary = summarizeKnownFailure(failure, reasonTags);
  const summarySource =
    knownSummary ??
    normalizeString((failure !== null && failure !== undefined ? failure.userMessage : undefined)) ??
    normalizeString((failure !== null && failure !== undefined ? failure.message : undefined)) ??
    legacyError ??
    fallback;
  const summary = trimLongInlineSummary(
    normalizeUserFacingErrorMessage(summarySource, undefined) ?? fallback,
  );
  const rawDetailText = stringifyDetail((failure !== null && failure !== undefined ? failure.details : undefined));
  const copyParts = [
    `摘要: ${summary}`,
    code ? `错误码: ${code}` : null,
    reasonTags.length > 0 ? `错误类型: ${reasonTags.join(", ")}` : null,
    backendText ? `服务返回内容:\n${backendText}` : null,
    rawDetailText ? `完整报错信息:\n${rawDetailText}` : null,
  ].filter((part): part is string => Boolean(part));

  return {
    title: "任务失败",
    summary,
    code,
    reasonTags,
    retryable: failure !== null && typeof failure.retryable === "boolean" ? failure.retryable : null,
    backendMessage: backendText,
    rawDetailText,
    copyText: copyParts.join("\n\n"),
  };
}
