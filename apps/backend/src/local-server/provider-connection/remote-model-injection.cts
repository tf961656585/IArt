import {
  isSerializedFormDataBody,
  parseInterfaceFormatRuleTarget,
  type ExecutionSnapshot,
  type SerializedFormDataBody,
  type SerializedFormDataField,
} from '@iart/contracts';
import { getInterfaceFormat } from '../interface-format/registry.cts';
import { resolveSnapshotProtocol } from './snapshot-protocol.cts';
import { isPlainObject } from '../utils.cts';
import { setQueryParamValue } from '../request-wire-utils.cts';
import * as loggingModule from '../logging.cts';

/**
 * remote_model_id 协议注入（spec 45 §5.2 / PDS-14 / PC-03）。
 *
 * - remote_model_id 是 Provider 原生模型 ID，只在该 Deployment 内有意义，绝不能替代产品 model_id；
 *   它只在任务实际派发前按 ExecutionSnapshot 注入实际请求，不写回能力包 payload 语义。
 * - 注入位置由**接口格式实体的请求规则树**裁定，不再由本文件维护适配器清单或「只认 body.model」：
 *   在 `transport.payload_rules` 里找值为 `{{model_id}}` 字面量的规则，按 target 解析成：
 *   - `body.<path>` → 请求体字段（支持嵌套路径，如 `config.model`）。JSON body 写嵌套属性；
 *     multipart 的 serialized 表单字段按同一路径的展平名（点号连接）替换；缺失时补插；
 *   - `api.query.<name>` → 查询参数（同名替换，不存在则追加，值用 URLSearchParams 编码）；
 *   - 地址路径里的 `{model}` 占位 → 路径段替换（沿用既有口径）。
 *
 * 规则树里没有 `{{model_id}}` 规则（如可灵把模型版本写死在 path 段）时，URL 里也没有 `{model}`，
 * 三处替换都是惰性的。
 *
 * 分类的唯一入口是 `resolveModelInjectionMode`：它按格式实体的请求规则派生注入落点，
 * 不在本文件维护第二份格式 id 清单。
 *
 * 注入只做协议字段替换，不修改能力包 payload 规则、不做 endpoint/body/auth/polling 覆盖。
 * 本文件是 remote_model_id 注入的单一事实源落点，禁止在轮询/取消/组装层再各自复制注入规则。
 */

/** 请求规则值里代表「这里发模型标识」的占位（实体 → 规则树的唯一编码）。 */
const MODEL_ID_RULE_VALUE = '{{model_id}}';

/**
 * 模型身份的注入落点（`resolveModelInjectionMode` 的返回形状）。
 *
 * `bodyPaths` / `queryNames` 都来自格式实体的 `payload_rules`；空数组 = 该位置不注入。
 */
export type ModelInjectionTargets = {
  bodyPaths: string[];
  queryNames: string[];
};

const EMPTY_TARGETS: ModelInjectionTargets = { bodyPaths: [], queryNames: [] };

/**
 * 动态请求体对象（键由接口格式的请求体路径决定，属开放结构）。
 *
 * 模型注入只按规则树里声明的路径写值，不拥有整棵请求体的固定字段形状；
 * 用 `Dynamic*` 命名把这条边界写在类型上。
 */
type DynamicBodyObject = Record<string, unknown>;

const isModelIdLiteralRule = (rule: unknown): boolean =>
  isPlainObject(rule) &&
  Reflect.get(rule, 'kind') === 'literal' &&
  Reflect.get(rule, 'value') === MODEL_ID_RULE_VALUE;

/**
 * 按接口格式实体派生 remote_model_id 的注入落点（**唯一分类入口**）。
 *
 * 格式未登记 / 未就绪 → 空落点（对话族没有接口格式实体，走 adapter 自身路径）。
 * 规则只按「值是不是 `{{model_id}}`」识别，因此新增落点（body 嵌套路径 / query）无需改本函数。
 */
export const resolveModelInjectionMode = (protocolId: string): ModelInjectionTargets => {
  const lookup = getInterfaceFormat(protocolId);
  if (lookup.kind !== 'ready') return EMPTY_TARGETS;
  const payloadRules = lookup.format.transport.payload_rules;
  const bodyPaths: string[] = [];
  const queryNames: string[] = [];
  for (const [target, rule] of Object.entries(payloadRules)) {
    if (!isModelIdLiteralRule(rule)) continue;
    const parsed = parseInterfaceFormatRuleTarget(target);
    if (parsed.kind === 'body_field') {
      bodyPaths.push(parsed.path);
      continue;
    }
    if (parsed.kind === 'query') {
      queryNames.push(parsed.name);
    }
  }
  return bodyPaths.length === 0 && queryNames.length === 0
    ? EMPTY_TARGETS
    : { bodyPaths, queryNames };
};

type InjectBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; code: string; message: string };

/** 按点号路径写嵌套属性（中间层不存在时创建对象）。 */
const setNestedBodyValue = (body: unknown, path: string, value: unknown): unknown => {
  const segments = path.split('.').filter((segment) => segment.length > 0);
  if (segments.length === 0) return body;
  if (!isPlainObject(body)) return body;
  const root: DynamicBodyObject = { ...body };
  let current: DynamicBodyObject = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment === undefined) return root;
    const existing = current[segment];
    const next: DynamicBodyObject = isPlainObject(existing) ? { ...existing } : {};
    current[segment] = next;
    current = next;
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) current[last] = value;
  return root;
};

/**
 * multipart serialized 表单字段注入。
 *
 * multipart 上 wire 的表单字段完全来自 `__formData.fields`，嵌套字段按点号展平
 * （序列化器：`config.model`）。替换保持原字段位置，缺失时补插；只改外层 plain object
 * 顶层属性会被 buildRequestBody 的 multipart 分支静默丢弃。
 */
const injectRemoteModelIdIntoSerializedForm = (
  bodyPaths: readonly string[],
  remoteModelId: string,
  body: SerializedFormDataBody,
): SerializedFormDataBody => {
  if (bodyPaths.length === 0) return body;
  const targetNames = new Set(bodyPaths);
  const sourceFields = Array.isArray(body.__formData.fields) ? body.__formData.fields : [];
  const seen = new Set<string>();
  const fields: SerializedFormDataField[] = [];
  for (const field of sourceFields) {
    const fieldName = isPlainObject(field) && typeof field.name === 'string' ? field.name : '';
    if (fieldName && targetNames.has(fieldName)) {
      seen.add(fieldName);
      fields.push({ ...field, value: remoteModelId });
      continue;
    }
    fields.push(field);
  }
  for (const path of bodyPaths) {
    if (seen.has(path)) continue;
    fields.unshift({ name: path, value: remoteModelId });
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
 * 按规则树声明的 body 路径注入 remote_model_id。
 *
 * - SerializedFormDataBody（multipart 预处理产物）注入 `__formData.fields`（见上）；
 * - plain object body 按嵌套路径写入（`config.model` 等）；
 * - 其余无效形态返回失败并留痕，调用方据此阻断而非静默降级（AGENTS.md 条件跳过留痕）。
 */
const injectRemoteModelIdIntoBody = (
  targets: ModelInjectionTargets,
  remoteModelId: string,
  body: unknown,
): InjectBodyResult => {
  if (targets.bodyPaths.length === 0) {
    return { ok: true, body };
  }
  if (isSerializedFormDataBody(body)) {
    return { ok: true, body: injectRemoteModelIdIntoSerializedForm(targets.bodyPaths, remoteModelId, body) };
  }
  if (!isPlainObject(body)) {
    loggingModule.logDebug('[remote-model-injection] body is not a plain object, cannot inject model', {
      bodyPaths: targets.bodyPaths,
      bodyType: typeof body,
    });
    return {
      ok: false,
      code: 'remote_model_injection_invalid_body',
      message: 'interface format requires a JSON object body to inject remote_model_id',
    };
  }
  let next: unknown = body;
  for (const path of targets.bodyPaths) {
    next = setNestedBodyValue(next, path, remoteModelId);
  }
  return { ok: true, body: next };
};

/**
 * 替换 URL 模板 `{model}` 占位符（路径段编码；不含占位时原样返回）。
 *
 * 历史口径保留：无论格式的模型落点是 body 还是 URL，只要地址里写了 `{model}` 就替换。
 */
const injectRemoteModelIdIntoUrl = (remoteModelId: string, url: string): string => {
  if (!url.includes('{model}')) return url;
  const encoded = encodeURIComponent(remoteModelId);
  return url.split('{model}').join(encoded);
};

const injectRemoteModelIdIntoQuery = (
  targets: ModelInjectionTargets,
  remoteModelId: string,
  url: string,
): string => {
  let next = url;
  for (const name of targets.queryNames) {
    next = setQueryParamValue(next, name, remoteModelId);
  }
  return next;
};

export type RemoteModelInjection = {
  /** 协议标识：生成 = 接口格式 id，对话 = 协议适配器 id。 */
  protocolId: string;
  remoteModelId: string;
};

/**
 * 对任务实际请求做 remote_model_id 注入（URL 路径 / 查询参数 / 请求体三个正交维度）。
 *
 * snapshot 必须在远端请求开始前冻结（spec 45 §5.2）；调用方保证 finalTargetUrl 的 origin
 * 来自 snapshot.base_url，本函数不重算 origin。
 *
 * 协议标识从快照冻结值取（旧快照按 adapter_id 回退解析）；解析不到协议时不注入——
 * 这类快照在派发阶段已被执行快照构建阻断，本函数只是不制造第二个失败点。
 *
 * 注入必须发生在 `buildRequestBody` 之前：表单正文一旦编码成字符串，body 路径上的
 * `{{model_id}}` 就再也改不动了。
 */
export const applyRemoteModelInjection = (params: {
  snapshot: ExecutionSnapshot;
  url: string;
  body: unknown;
  /**
   * 是否注入请求体（缺省 true）。
   *
   * 派发早期只解析地址时传 false：此时 body 可能还是未预处理的文本/占位形态，
   * 提前要求它是对象会让「模型只落在 URL/query」的格式被误判为无效请求。
   */
  injectBody?: boolean;
}): { url: string; body: unknown } => {
  const { snapshot, url, body } = params;
  const resolved = resolveSnapshotProtocol(snapshot);
  const protocolId = resolved === null
    ? ''
    : resolved.kind === 'generation_format'
      ? resolved.format_id
      : resolved.adapter_id;
  const targets = resolveModelInjectionMode(protocolId);
  const urlWithModelPath = injectRemoteModelIdIntoUrl(snapshot.remote_model_id, url);
  const urlResult = injectRemoteModelIdIntoQuery(targets, snapshot.remote_model_id, urlWithModelPath);
  if (!urlResult.trim()) {
    throw new Error('remote_model_id injection produced an empty URL');
  }
  if (params.injectBody === false) {
    return { url: urlResult, body };
  }
  const bodyResult = injectRemoteModelIdIntoBody(targets, snapshot.remote_model_id, body);
  if (!bodyResult.ok) {
    throw new Error(bodyResult.message);
  }
  return { url: urlResult, body: bodyResult.body };
};

export {
  injectRemoteModelIdIntoUrl,
  injectRemoteModelIdIntoBody,
};
