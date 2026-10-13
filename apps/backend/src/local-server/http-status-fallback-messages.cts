/**
 * 内置 HTTP 状态码 → userMessage 兜底层。
 *
 * 性质：兜底层，不是主映射。厂商自己的 error_mapping_rules（body 字段映射）优先级高于本表
 * （调用方在 mappedUserMessage 为空时才查本表）。
 *
 * 收录原则：只收「无专门处理且语义稳定」的码。
 * - 451/409/422/429：语义标准化，跨厂商一致。
 * - 5xx：远端服务侧故障，区间覆盖。
 * 不收 400/401/403/408：401/403 走 credentials；408 走 forter_inactive。这些码有专门分支，
 * 文案层由各自链路产出，避免通用文案冲突。
 */
const HTTP_STATUS_USER_MESSAGE_FALLBACK: ReadonlyMap<number, string> = new Map([
  [451, "该服务因地区或法律法规限制，在您所在区域不可用。请检查网络环境（如代理/VPN 出口地区）后重试。"],
  [409, "请求与当前资源状态冲突，通常因任务重复或资源已被修改。请刷新后重试。"],
  [422, "服务端拒绝了请求的参数语义。请检查输入内容是否符合要求。"],
  [429, "请求过于频繁，已被限流。请稍后重试。"],
]);

const SERVER_ERROR_USER_MESSAGE = "远端服务暂时不可用。请稍后重试，若持续失败请联系支持。";

/**
 * 按 httpStatus 解析内置兜底 userMessage。
 * 命中精确码返回对应文案；5xx 返回服务器错误文案；其余返回 null（交给上游其余兜底链）。
 */
export const resolveHttpStatusUserMessage = (
  httpStatus: number | null | undefined,
): string | null => {
  if (httpStatus == null) return null;
  const exact = HTTP_STATUS_USER_MESSAGE_FALLBACK.get(httpStatus);
  if (exact) return exact;
  if (httpStatus >= 500 && httpStatus < 600) return SERVER_ERROR_USER_MESSAGE;
  return null;
};
