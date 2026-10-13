import {
  isJsonContentType,
  isTextContentType,
} from "./task-engine-request.cts";
import {
  ERROR_CODES,
  type PlainObject,
} from "./task-engine-shared.cts";

// 部分第三方网关/中转会把 JSON 响应包成 text/plain 返回（实测案例：gemini 文生图经第三方中转）。
// 仅按 Content-Type 判定是否 JSON.parse 会让这类响应被当成纯文本存进 response.body，
// 下游 output_mapping_rules 的路径解析器无法在字符串上命中字段，导致「映射未命中」误判。
// 这里对「看起来像 JSON」的文本做兜底 parse：去除首尾空白后以 { 或 [ 开头才尝试，避免对普通文本误判。
const looksLikeJsonText = (text: string) => {
  const head = text.trimStart().slice(0, 1);
  return head === "{" || head === "[";
};

const parseInlineTextToBody = (text: string): { body: unknown; bodyType: string } => {
  if (!looksLikeJsonText(text)) return { body: text, bodyType: "text" };
  try {
    return { body: JSON.parse(text) as unknown, bodyType: "json" };
  } catch {
    return { body: text, bodyType: "text" };
  }
};

// polling 路径与 http sync 路径共用同一兜底口径：Content-Type 可能被中转网关误标，
// 是否 JSON.parse 由文本内容（是否以 { 或 [ 开头）决定，不由 Content-Type 决定。
// polling 场景下 evaluationBody 与 body 同源：轮询的状态/进度/成功判定与下游
// output_mapping_rules 物化读取的是同一份解析结果，避免「轮询判定成功但物化映射未命中」。
const parsePollingResponseBody = (params: {
  buffer: Buffer;
  contentType: string;
}): { body: unknown; bodyType: string | null; evaluationBody: unknown } => {
  if (params.buffer.length === 0) {
    return { body: null, bodyType: null, evaluationBody: null };
  }
  if (!isTextContentType(params.contentType)) {
    return { body: null, bodyType: null, evaluationBody: null };
  }
  const parsed = parseInlineTextToBody(params.buffer.toString("utf-8"));
  return {
    body: parsed.body,
    bodyType: parsed.bodyType,
    evaluationBody: parsed.body,
  };
};

const buildResponsePayload = (params: {
  response: Response;
  contentType: string;
  receivedBytes: number;
  responseHeaders: Headers;
  attempt: number;
  inlineChunks: Buffer[];
}) => {
  let body: unknown = null;
  let bodyType: string | null = null;
  if (params.inlineChunks.length > 0) {
    const buffer = Buffer.concat(params.inlineChunks);
    if (buffer.length > 0) {
      const text = buffer.toString("utf-8");
      // 不论 Content-Type 是否为 JSON 都走同一兜底路径：
      // Content-Type=application/json 时按既有契约必须 parse（失败也保留为 text）；
      // Content-Type=text/plain 等非 JSON 时，若文本看起来像 JSON（以 { 或 [ 开头）也尝试 parse，
      // 失败或不是 JSON 则原样保留为 text。两条路径合一，避免中转网关误标 Content-Type 导致下游映射落空。
      const parsed = parseInlineTextToBody(text);
      body = parsed.body;
      bodyType = parsed.bodyType;
    }
  }
  return {
    status: params.response.status,
    ok: params.response.ok,
    contentType: params.contentType,
    size: params.receivedBytes,
    headers: params.responseHeaders,
    receivedAt: new Date().toISOString(),
    attempt: params.attempt,
    body,
    bodyType,
    // file 字段保留为 null 以维持 response 对象 shape 稳定（下游 projector/writer 仍读取该字段）。
    // 历史「大响应落盘到 resultFile」能力已移除，响应体统一走 inline 解析，无独立文件产物。
    file: null,
  };
};

const buildIntegrityErrorIfNeeded = (params: {
  contentType: string;
  expectedSize: number | null;
  receivedBytes: number;
  responseBodyType: string | null;
  responseOk: boolean;
}) => {
  const buildIntegrityError = (
    message: unknown,
    extra: PlainObject = {} as PlainObject,
  ): PlainObject => {
    const result: PlainObject = { ...extra };
    result.code = ERROR_CODES.TASK_INCOMPLETE_RESPONSE;
    result.message = message;
    return result;
  };
  if (
    params.expectedSize !== null &&
    Number.isFinite(params.expectedSize) &&
    params.expectedSize > 0 &&
    params.receivedBytes < params.expectedSize
  ) {
    return buildIntegrityError(
      `响应下载不完整（${params.receivedBytes}/${params.expectedSize} bytes）`,
      {
        expectedSize: params.expectedSize,
        receivedBytes: params.receivedBytes,
      } as PlainObject,
    );
  }
  if (!params.responseOk || !isJsonContentType(params.contentType)) return null;
  // 响应体统一走 inline 解析，无独立文件产物。完整性只校验 inline 解析结果：
  // JSON Content-Type 下若未能 parse 成功（bodyType 仍为 text），视为截断。
  return params.responseBodyType === "json"
    ? null
    : buildIntegrityError("响应 JSON 解析失败（可能被截断）");
};

export {
  buildResponsePayload,
  buildIntegrityErrorIfNeeded,
  parsePollingResponseBody,
};
