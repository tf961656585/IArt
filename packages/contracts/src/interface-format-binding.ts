import { z } from 'zod';

/**
 * 接口格式的**请求落点（binding）与线路名称校验**（共享层，跨进程唯一实现）。
 *
 * 背景（2026-10-27 自定义接口格式请求方式批次）：自定义格式的请求落点从「只发请求体」扩展到
 * 请求体 / 查询参数 / 请求头三个命名空间，提示词另可落到纯文本正文，模型 ID 另可落到地址路径。
 * Hub 表单、Runtime Backend 的草稿校验、实体校验与详情视图必须用**同一份**名称/值规则与
 * 目标路径语法，否则同一份草稿在三处得到不同结论（界面放行、保存拒绝，或反之）。
 *
 * 本文件只承载纯函数与形状 schema：
 * - 三个命名空间的 binding 形状（请求体路径 / 查询参数名 / 请求头名）；
 * - 请求体路径语法与重叠判定（原在 `custom-interface-format-contract.ts`，为让本模块不反向
 *   依赖草稿契约而下沉到这里，草稿契约原样 re-export，公开名不变）；
 * - 请求头 / 查询参数名称与值的合法性判定、禁止请求头清单；
 * - 请求规则 target 字符串（`body.<path>` / `api.query.<name>` / `api.headers.<name>` …）
 *   的解析与反向格式化；
 * - 从相对路径的静态查询串提取参数名（冲突校验用）。
 *
 * 依赖方向：本模块只依赖 zod；`custom-interface-format-contract.ts` 与
 * `custom-generation-model-contract.ts` 都从它取形状，禁止反向依赖。
 */

// ---------------------------------------------------------------------------
// 请求体路径
// ---------------------------------------------------------------------------

/**
 * 请求体路径（点号分段，支持嵌套）：`prompt` / `input.text` / `options.size`。
 *
 * 分段字符集与请求规则键的定位口径一致（规则树按 `.` 切分定位），因此不放开 `.` 以外的
 * 分隔符；空段（`a..b` / 首尾点）一律拒绝——它会让规则树落到一个不存在的中间层。
 */
export const INTERFACE_FORMAT_BODY_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

export const InterfaceFormatBodyPathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(INTERFACE_FORMAT_BODY_PATH_PATTERN, 'interface_format_body_path_invalid');

/**
 * 提交路径必须相对：以 `/` 开头、无 scheme/host、无 `..` 段、无空白与反斜杠。
 *
 * 为什么钉死在契约而不是只在 backend 校验：Hub 需要即时提示同一份规则，且草稿是跨进程输入，
 * 边界校验必须在消费端（契约）就成立。
 */
export const isRelativeSubmitPath = (path: string): boolean => {
  if (!path.startsWith('/')) return false;
  // 协议相对地址（`//host/path`）会被请求层当成外部主机。
  if (path.startsWith('//')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return false;
  if (/[\s\\]/.test(path)) return false;
  return !path.split('/').includes('..');
};

/**
 * 两个请求体路径是否重叠：相等，或一个包含另一个（`input` 与 `input.text`）。
 *
 * 同一棵请求体树上，祖孙路径会写同一个对象：后写者覆盖先写者，用户看不到任何提示。
 * 因此「不能重复」的判据必须是路径重叠，不能只做字符串全等。
 */
export const interfaceFormatBodyPathsOverlap = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);

// ---------------------------------------------------------------------------
// 线路名称与值
// ---------------------------------------------------------------------------

/** 请求头 / 查询参数名的长度上限（与草稿里 `header_name` / `query_name` 的口径一致）。 */
export const INTERFACE_FORMAT_WIRE_NAME_MAX_LENGTH = 120;

/** 请求头值 / 查询参数值的长度上限。 */
export const INTERFACE_FORMAT_WIRE_VALUE_MAX_LENGTH = 8192;

/**
 * HTTP field-name 的 token 字符集（RFC 7230 §3.2.6）。
 *
 * 名称会原样进入请求行/请求头，空格、冒号、控制字符都会改变报文结构，因此只允许 token。
 */
export const INTERFACE_FORMAT_HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * 查询参数名字符集：字母数字、下划线、点、短横线、方括号。
 *
 * 方括号用于 `a[]` 形式的数组参数；`&` `=` `#` `?` 与空白会改变查询串结构，一律拒绝。
 */
export const INTERFACE_FORMAT_QUERY_PARAM_NAME_PATTERN = /^[A-Za-z0-9_.\-[\]]+$/;

/** 值里是否含 C0 控制字符或 DEL（CR/LF 是最关键的两种）。 */
const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

/**
 * 由运行时/请求库接管的请求头：用户声明同名固定头或参数绑定会与它们互相覆盖，
 * 或直接改变报文边界（`content-length` / `transfer-encoding`）。
 *
 * `content-type` 的单一来源是提交段的 `content_type` 字段（multipart 由运行时按边界生成）；
 * `authorization` 的单一来源是鉴权形状（`auth`）。两者都不得再由固定头表达。
 */
export const FORBIDDEN_REQUEST_HEADER_NAMES: readonly string[] = [
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'content-type',
  'authorization',
];

const FORBIDDEN_REQUEST_HEADER_NAME_SET: ReadonlySet<string> = new Set(FORBIDDEN_REQUEST_HEADER_NAMES);

/** 请求头名比较口径（大小写不敏感）：任何「是不是同一个头」的判定都必须先过这里。 */
export const normalizeHeaderName = (name: string): string => name.trim().toLowerCase();

export const isValidHttpHeaderName = (name: string): boolean =>
  name.length >= 1 &&
  name.length <= INTERFACE_FORMAT_WIRE_NAME_MAX_LENGTH &&
  INTERFACE_FORMAT_HTTP_HEADER_NAME_PATTERN.test(name);

/** 请求头值：允许空串，拒绝 CR/LF 与其它控制字符，长度上限 8192。 */
export const isValidHttpHeaderValue = (value: string): boolean =>
  value.length <= INTERFACE_FORMAT_WIRE_VALUE_MAX_LENGTH && !hasControlCharacter(value);

export const isForbiddenRequestHeaderName = (name: string): boolean =>
  FORBIDDEN_REQUEST_HEADER_NAME_SET.has(normalizeHeaderName(name));

export const isValidQueryParamName = (name: string): boolean =>
  name.length >= 1 &&
  name.length <= INTERFACE_FORMAT_WIRE_NAME_MAX_LENGTH &&
  INTERFACE_FORMAT_QUERY_PARAM_NAME_PATTERN.test(name);

/** 查询参数值：允许空串，拒绝控制字符，长度上限 8192（`{}` 占位符按普通字符处理）。 */
export const isValidQueryParamValue = (value: string): boolean =>
  value.length <= INTERFACE_FORMAT_WIRE_VALUE_MAX_LENGTH && !hasControlCharacter(value);

/**
 * 一对「名称 → 值」的线路常量（固定请求头 / 固定查询参数）。
 *
 * 名称与值的字符集**按位置**不同（请求头是 token、查询参数名放开方括号），schema 只约束长度：
 * 位置相关的字符合法性由各自的消费端用上面的判定函数校验（草稿是 Hub 输入、实体是预设文件，
 * 两处的错误路径不同，但判据同源）。
 */
export const InterfaceFormatNameValueSchema = z
  .object({
    name: z.string().trim().min(1).max(INTERFACE_FORMAT_WIRE_NAME_MAX_LENGTH),
    value: z.string().max(INTERFACE_FORMAT_WIRE_VALUE_MAX_LENGTH),
  })
  .strict();

export type InterfaceFormatNameValue = z.infer<typeof InterfaceFormatNameValueSchema>;

export const InterfaceFormatHeaderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(INTERFACE_FORMAT_WIRE_NAME_MAX_LENGTH)
  .regex(INTERFACE_FORMAT_HTTP_HEADER_NAME_PATTERN, 'interface_format_header_name_invalid');

export const InterfaceFormatQueryParamNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(INTERFACE_FORMAT_WIRE_NAME_MAX_LENGTH)
  .regex(INTERFACE_FORMAT_QUERY_PARAM_NAME_PATTERN, 'interface_format_query_name_invalid');

// ---------------------------------------------------------------------------
// 落点 binding
// ---------------------------------------------------------------------------

/** 落点：请求体路径。 */
export const InterfaceFormatBodyBindingSchema = z
  .object({
    location: z.literal('body'),
    path: InterfaceFormatBodyPathSchema,
  })
  .strict();

/** 落点：查询参数（值为提交时的取值）。 */
export const InterfaceFormatQueryBindingSchema = z
  .object({
    location: z.literal('query'),
    name: InterfaceFormatQueryParamNameSchema,
  })
  .strict();

/** 落点：请求头（值为提交时的取值）。 */
export const InterfaceFormatHeaderBindingSchema = z
  .object({
    location: z.literal('header'),
    name: InterfaceFormatHeaderNameSchema,
  })
  .strict();

/** 参数（以及任何「一个值发到一个位置」的绑定）的三种落点。 */
export const InterfaceFormatValueBindingSchema = z.discriminatedUnion('location', [
  InterfaceFormatBodyBindingSchema,
  InterfaceFormatQueryBindingSchema,
  InterfaceFormatHeaderBindingSchema,
]);

export type InterfaceFormatBodyBinding = z.infer<typeof InterfaceFormatBodyBindingSchema>;
export type InterfaceFormatQueryBinding = z.infer<typeof InterfaceFormatQueryBindingSchema>;
export type InterfaceFormatHeaderBinding = z.infer<typeof InterfaceFormatHeaderBindingSchema>;
export type InterfaceFormatValueBinding = z.infer<typeof InterfaceFormatValueBindingSchema>;

/**
 * 提示词落点：请求体路径 / 查询参数 / 纯文本正文（`text`）。
 *
 * `text` 只在 `payload_format = 'text'` 时成立：整个请求体就是提示词本身，因此不与请求体
 * 路径共存（两者会争同一个正文）。
 */
export const InterfaceFormatPromptBindingSchema = z.discriminatedUnion('location', [
  InterfaceFormatBodyBindingSchema,
  InterfaceFormatQueryBindingSchema,
  z.object({ location: z.literal('text') }).strict(),
]);

export type InterfaceFormatPromptBinding = z.infer<typeof InterfaceFormatPromptBindingSchema>;

/**
 * 模型 ID 落点：请求体路径 / 查询参数 / 地址路径（`path`）。
 *
 * `path` 使用提交路径里既有的 `{model}` 占位（与预设格式同一占位语法）；没有占位时声明
 * `path` 等于「模型 ID 不会出现在任何地方」，由写入侧校验拒绝。
 */
export const InterfaceFormatModelBindingSchema = z.discriminatedUnion('location', [
  InterfaceFormatBodyBindingSchema,
  InterfaceFormatQueryBindingSchema,
  z.object({ location: z.literal('path') }).strict(),
]);

export type InterfaceFormatModelBinding = z.infer<typeof InterfaceFormatModelBindingSchema>;

// ---------------------------------------------------------------------------
// 请求规则 target 语法
// ---------------------------------------------------------------------------

/**
 * 请求规则树里一个 target 字符串的解析结果。
 *
 * - `body_field`：`body.<path>`，请求体里的一个字段；
 * - `body_text`：`body`，整个请求体就是该值（纯文本正文）；
 * - `query` / `header`：`api.query.<name>` / `api.headers.<name>`，线路常量或字段绑定；
 * - `api_endpoint` / `api_method` / `api_content_type`：传输元信息；
 * - `meta`：`meta.<path>`，面板语义字段（不发到 wire）；
 * - `other`：顶层回显键（`prompt` / `input`）以及任何未登记形态。
 */
export type InterfaceFormatRuleTarget =
  | { kind: 'body_field'; path: string }
  | { kind: 'body_text' }
  | { kind: 'query'; name: string }
  | { kind: 'header'; name: string }
  | { kind: 'api_endpoint' }
  | { kind: 'api_method' }
  | { kind: 'api_content_type' }
  | { kind: 'meta'; path: string }
  | { kind: 'other'; target: string };

const API_QUERY_PREFIX = 'api.query.';
const API_HEADER_PREFIX = 'api.headers.';
const BODY_PREFIX = 'body.';
const META_PREFIX = 'meta.';

/**
 * 解析请求规则 target（唯一实现）。
 *
 * 只按前缀做**结构性**解析，不校验名称/路径的字符集：合法性由调用方按位置分别判定
 * （请求头名与查询参数名的规则不同，混在一个解析器里会把位置信息丢掉）。
 */
export const parseInterfaceFormatRuleTarget = (target: string): InterfaceFormatRuleTarget => {
  if (target === 'body') return { kind: 'body_text' };
  if (target.startsWith(BODY_PREFIX)) {
    const path = target.slice(BODY_PREFIX.length);
    return path.length > 0 ? { kind: 'body_field', path } : { kind: 'other', target };
  }
  if (target.startsWith(API_QUERY_PREFIX)) {
    const name = target.slice(API_QUERY_PREFIX.length);
    return name.length > 0 ? { kind: 'query', name } : { kind: 'other', target };
  }
  if (target.startsWith(API_HEADER_PREFIX)) {
    const name = target.slice(API_HEADER_PREFIX.length);
    return name.length > 0 ? { kind: 'header', name } : { kind: 'other', target };
  }
  if (target === 'api.endpoint') return { kind: 'api_endpoint' };
  if (target === 'api.method') return { kind: 'api_method' };
  if (target === 'api.contentType') return { kind: 'api_content_type' };
  if (target.startsWith(META_PREFIX)) {
    const path = target.slice(META_PREFIX.length);
    return path.length > 0 ? { kind: 'meta', path } : { kind: 'other', target };
  }
  return { kind: 'other', target };
};

/**
 * 可寻址到 wire 的 binding（`formatInterfaceFormatBindingTarget` 的入参）。
 *
 * 模型 ID 的 `{ location: 'path' }` 故意**不在**这个联合里：它表达的是地址模板里的占位，
 * 不产生请求规则 target。让它在类型层就进不来，比在函数里抛错更早暴露误用。
 */
export type InterfaceFormatAddressableBinding =
  | InterfaceFormatBodyBinding
  | InterfaceFormatQueryBinding
  | InterfaceFormatHeaderBinding
  | { location: 'text' };

/**
 * binding → 请求规则 target 字符串（唯一实现，供合成与只读回填共用）。
 *
 * 与 `parseInterfaceFormatRuleTarget` 严格互逆：`body` + path → `body.<path>`（纯文本 → `body`），
 * `query` → `api.query.<name>`，`header` → `api.headers.<name>`。
 */
export const formatInterfaceFormatBindingTarget = (binding: InterfaceFormatAddressableBinding): string => {
  switch (binding.location) {
    case 'body':
      return `${BODY_PREFIX}${binding.path}`;
    case 'text':
      return 'body';
    case 'query':
      return `${API_QUERY_PREFIX}${binding.name}`;
    case 'header':
      return `${API_HEADER_PREFIX}${binding.name}`;
  }
};

// ---------------------------------------------------------------------------
// 路径里的静态查询串
// ---------------------------------------------------------------------------

/** 查询串里的百分号解码：非法编码按原文处理（名称仍参与比较，不静默丢弃）。 */
const decodeQueryComponent = (raw: string): string => {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
};

/**
 * 从相对路径的静态查询串（`?` 之后）提取参数名。
 *
 * 用于冲突校验：路径里写死的查询参数与固定查询参数 / 查询参数绑定 / 鉴权 query 名重名时，
 * 同一个参数会出现两次（后写覆盖先写，或直接拼出重复键），必须在写入侧拒绝。
 * 模板占位（`?task_ids={id}`）只影响值，不影响名称。
 */
export const extractQueryParamNamesFromPath = (path: string): string[] => {
  const queryIndex = path.indexOf('?');
  if (queryIndex < 0) return [];
  const names: string[] = [];
  for (const pair of path.slice(queryIndex + 1).split('&')) {
    if (pair.length === 0) continue;
    const rawName = pair.split('=')[0] ?? '';
    if (rawName.length === 0) continue;
    names.push(decodeQueryComponent(rawName));
  }
  return names;
};

// ---------------------------------------------------------------------------
// 通用 JSON 值（轮询请求体）
// ---------------------------------------------------------------------------

export type InterfaceFormatJsonValue =
  | string
  | number
  | boolean
  | null
  | InterfaceFormatJsonValue[]
  | { [key: string]: InterfaceFormatJsonValue };

/** 任意 JSON 值（轮询请求体使用；结构由该接口自己的文档决定，契约只管「是不是 JSON」）。 */
export const InterfaceFormatJsonValueSchema: z.ZodType<InterfaceFormatJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(InterfaceFormatJsonValueSchema),
    z.record(z.string(), InterfaceFormatJsonValueSchema),
  ]),
);
