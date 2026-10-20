import {
  isSerializedFormDataBody,
  type ExecutionSnapshot,
  type ProtocolAdapterId,
  type SerializedFormDataBody,
  type SerializedFormDataField,
} from '@iart/contracts';
import { isPlainObject } from '../utils.cts';
import * as loggingModule from '../logging.cts';

/**
 * remote_model_id 协议注入（spec 45 §5.2 / PDS-14 / PC-03）。
 *
 * - remote_model_id 是 Provider 原生模型 ID，只在该 Deployment 内有意义，绝不能替代产品 model_id；
 *   它只在任务实际派发前按 ExecutionSnapshot 注入实际请求，不写回能力包 payload 语义。
 * - 五类 adapter 的注入位置（docs/provider-remote-apis/README.md + 02..07 主口径）：
 *   - openai-image-v1：请求模型字段 = remote_model_id。JSON body（t2i /v1/images/generations）
 *     注入顶层 `model` 属性；i2i multipart body（SerializedFormDataBody，/v1/images/edits）
 *     注入 `__formData.fields` 中 name="model" 的表单字段——multipart 上 wire 的表单字段
 *     完全由 fields 承载（buildRequestBody 的 multipart 分支只读 __formData，忽略顶层属性），
 *     该字段由 payload_rules `body.model` 字面量展平而来，值是产品 model_id，必须替换。
 *   - veo-v1：URL 模板 `{model}` 占位替换为 remote_model_id
 *     （按上游规则 URL 编码）。
 *   - gemini-image-interactions-v1：请求体顶层 `model` = remote_model_id
 *     （Interactions API 端点 `/v1beta/interactions` 无 `{model}` 占位符）。
 *   - seedance-2-0-v1：请求 body 顶层 `model` = remote_model_id（Seedance 2.0 创建任务契约 §6）。
 *   - kling-text2video-v1 / kling-image2video-v1 / kling-omni-video-v1（可灵官方**新设计
 *     标准**，2026-10-19 起按三个提交端点拆成三个适配器）：模型身份由 URL path 承载，
 *     请求体**没有**任何模型字段（无 `model_name`、无 `model`），因此归 URL 模板类而非
 *     body 类。归入 body 类会向可灵上游注入一个其契约未定义的顶层 `model` 字段。
 *     注意当前口径：可灵新标准把模型版本写死在 path 段（`/text-to-video/kling-3.0`、
 *     `/image-to-video/kling-3.0`、`/omni-video/kling-3.0-omni`，见
 *     docs/provider-remote-apis/07-Kling-视频生成接口.md §5），所以已声明的这些相对路径**不含**
 *     `{model}` 占位符，替换在今天是惰性的——本条目表达的是「模型身份在 URL 而非 body」这一
 *     分类事实；若后续引入 `/text-to-video/{model}` 形态，替换会立即生效。
 *
 * 注入只做协议字段替换，不修改能力包 payload 规则、不做 endpoint/body/auth/polling 覆盖。
 * 本文件是 remote_model_id 注入的单一事实源落点，禁止在轮询/取消/组装层再各自复制注入规则。
 */

const ADAPTER_IDS_WITH_BODY_MODEL: ReadonlySet<ProtocolAdapterId> = new Set([
  'openai-image-v1',
  'seedance-2-0-v1',
  // Gemini Images Interactions API 的端点 `/v1beta/interactions` 不含 `{model}` 占位符，
  // 产品模型身份由请求体顶层 `model` 承载，因此归 body 注入而非 URL 模板注入。
  'gemini-image-interactions-v1',
]);

const ADAPTER_IDS_WITH_URL_MODEL_TEMPLATE: ReadonlySet<ProtocolAdapterId> = new Set([
  'veo-v1',
  // 可灵新标准三个端点：模型身份在 URL path，请求体无模型字段（spec 07 §5 / §7.1）。
  // 三个条目必须同时在此集合内——分类事实是「模型身份在 URL 而非 body」，与路径当前是否
  // 含 `{model}` 占位符无关（不含时替换惰性，但绝不能落到 body 类去多注入一个字段）。
  'kling-text2video-v1',
  'kling-image2video-v1',
  'kling-omni-video-v1',
]);

type InjectBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; code: string; message: string };

const MODEL_BODY_FIELD = 'model';

/**
 * 对 i2i multipart body（SerializedFormDataBody）注入 model 表单字段。
 *
 * multipart 上 wire 的表单字段完全来自 `__formData.fields`：其中 name="model" 的字段
 * 由 payload_rules `body.model` 字面量（产品 model_id）展平而来，必须替换为
 * remote_model_id；只改外层 plain object 顶层属性会被 buildRequestBody 的 multipart
 * 分支静默丢弃，远端收到的仍是产品 model_id。替换保持原字段位置，缺失时补插。
 */
const injectRemoteModelIdIntoSerializedForm = (
  remoteModelId: string,
  body: SerializedFormDataBody,
): SerializedFormDataBody => {
  const modelField: SerializedFormDataField = { name: MODEL_BODY_FIELD, value: remoteModelId };
  const sourceFields = Array.isArray(body.__formData.fields) ? body.__formData.fields : [];
  let replaced = false;
  const fields: SerializedFormDataField[] = [];
  for (const field of sourceFields) {
    if (isPlainObject(field) && field.name === MODEL_BODY_FIELD) {
      replaced = true;
      fields.push(modelField);
      continue;
    }
    fields.push(field);
  }
  if (!replaced) {
    fields.unshift(modelField);
  }
  return {
    ...body,
    __formData: {
      ...body.__formData,
      fields,
    },
  };
};

/**
 * 按 adapter 协议注入 body 顶层 `model` 字段。
 *
 * - SerializedFormDataBody（openai edits 的 i2i multipart 形态）注入 `__formData.fields`
 *   中的 model 表单字段（见 injectRemoteModelIdIntoSerializedForm）。
 * - plain object body 注入顶层 `model` 属性（JSON body，t2i 与 Seedance 2.0 路径）。
 * - 其余无效形态返回失败并留痕，调用方据此阻断而非静默降级（AGENTS.md 条件跳过留痕）。
 */
const injectRemoteModelIdIntoBody = (
  adapterId: ProtocolAdapterId,
  remoteModelId: string,
  body: unknown,
): InjectBodyResult => {
  if (!ADAPTER_IDS_WITH_BODY_MODEL.has(adapterId)) {
    return { ok: true, body };
  }
  if (isSerializedFormDataBody(body)) {
    return { ok: true, body: injectRemoteModelIdIntoSerializedForm(remoteModelId, body) };
  }
  if (!isPlainObject(body)) {
    loggingModule.logDebug('[remote-model-injection] body is not a plain object, cannot inject model', {
      adapterId,
      bodyType: typeof body,
    });
    return {
      ok: false,
      code: 'remote_model_injection_invalid_body',
      message: `adapter ${adapterId} requires a JSON object body to inject remote_model_id`,
    };
  }
  return { ok: true, body: { ...body, model: remoteModelId } };
};

type InjectUrlResult =
  | { ok: true; url: string }
  | { ok: false; code: string; message: string };

/**
 * 按 adapter 协议替换 URL 模板 `{model}` 占位符。
 *
 * - 占位符替换使用 encodeURIComponent（URL 路径段编码），避免把上游路径语义破坏。
 * - 不含 `{model}` 占位时原样返回（Gemini 与可灵三个端点的轮询路径不含 {model}，不注入）。
 */
const injectRemoteModelIdIntoUrl = (
  adapterId: ProtocolAdapterId,
  remoteModelId: string,
  url: string,
): InjectUrlResult => {
  if (!ADAPTER_IDS_WITH_URL_MODEL_TEMPLATE.has(adapterId)) {
    return { ok: true, url };
  }
  if (!url.includes('{model}')) {
    return { ok: true, url };
  }
  const encoded = encodeURIComponent(remoteModelId);
  const next = url.split('{model}').join(encoded);
  if (!next.trim()) {
    return { ok: false, code: 'remote_model_injection_invalid_url', message: 'remote_model_id URL template replacement produced an empty URL' };
  }
  return { ok: true, url: next };
};

export type RemoteModelInjection = {
  adapterId: ProtocolAdapterId;
  remoteModelId: string;
};

/**
 * 对任务实际请求做 remote_model_id 注入（body 与 URL 模板两个正交维度）。
 *
 * snapshot 必须在远端请求开始前冻结（spec 45 §5.2）；调用方保证 finalTargetUrl 的 origin
 * 来自 snapshot.base_url，本函数不重算 origin。
 */
export const applyRemoteModelInjection = (params: {
  snapshot: ExecutionSnapshot;
  url: string;
  body: unknown;
}): { url: string; body: unknown } => {
  const { snapshot, url, body } = params;
  const urlResult = injectRemoteModelIdIntoUrl(snapshot.adapter_id, snapshot.remote_model_id, url);
  if (!urlResult.ok) {
    throw new Error(urlResult.message);
  }
  const bodyResult = injectRemoteModelIdIntoBody(snapshot.adapter_id, snapshot.remote_model_id, body);
  if (!bodyResult.ok) {
    throw new Error(bodyResult.message);
  }
  return { url: urlResult.url, body: bodyResult.body };
};

export {
  injectRemoteModelIdIntoUrl,
  injectRemoteModelIdIntoBody,
};
