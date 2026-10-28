import { z } from 'zod';

import {
  GenerationMediaSlotIdSchema,
  InterfaceFormatDetailSchema,
  InterfaceFormatIdSchema,
} from './custom-generation-model-contract';
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from './model-asset-contract/protocol-constants';
import {
  InterfaceRecipeIdSchema,
  RecipeConditionSchema,
  RecipeResultFormSchema,
} from './interface-recipe-contract';
import {
  extractQueryParamNamesFromPath,
  INTERFACE_FORMAT_BODY_PATH_PATTERN,
  InterfaceFormatBodyBindingSchema,
  InterfaceFormatBodyPathSchema,
  InterfaceFormatHeaderBindingSchema,
  InterfaceFormatJsonValueSchema,
  InterfaceFormatModelBindingSchema,
  InterfaceFormatNameValueSchema,
  InterfaceFormatPromptBindingSchema,
  InterfaceFormatQueryBindingSchema,
  InterfaceFormatValueBindingSchema,
  interfaceFormatBodyPathsOverlap,
  isForbiddenRequestHeaderName,
  isRelativeSubmitPath,
  isValidHttpHeaderName,
  isValidHttpHeaderValue,
  isValidQueryParamName,
  isValidQueryParamValue,
  normalizeHeaderName,
  type InterfaceFormatModelBinding,
  type InterfaceFormatPromptBinding,
  type InterfaceFormatValueBinding,
} from './interface-format-binding';

/**
 * 用户自建接口格式的**声明式草稿**（跨进程唯一 owner）。
 *
 * 背景（2026-10-26 批次 B5a）：接口格式实体（`apps/backend/src/local-server/interface-format/`）
 * 已把「某类生成接口的传输形状、参数表、投影与文案」收敛成数据。预设随软件分发、只读；
 * 本契约承载 Hub 提交的**用户自建草稿**，由 Runtime Backend 合成成完整实体 + 一份判定配方。
 *
 * 覆盖范围：同步与异步（任务标识 / 轮询段）、三种结果形态（含 `needs_fetch`）、
 * 参数与素材位、失败判定与失败原因；素材输入的公网中转规则由运行时按载体展开。
 * 草稿是**输入 DTO**，不是持久化实体。持久化实体仍由 backend 的接口格式实体 schema 承载，
 * Hub 不持有第二份实体形状。
 *
 * 请求落点（2026-10-27 批次）：参数、提示词、模型 ID 各自声明发到**请求体 / 查询参数 /
 * 请求头**（提示词另有纯文本正文、模型 ID 另有地址路径）；提交段另有两张「固定请求头」与
 * 「固定查询参数」小表。三个命名空间的名称/路径规则与冲突判定唯一实现在
 * `interface-format-binding.ts`，Hub 与 Runtime Backend 共用。
 *
 * `.strict()` 与默认值：Hub 提交的字段以本文件为唯一形状；新增可选字段一律带 `.default(...)`，
 * 让旧客户端提交的请求体仍然可用（缺键即取默认值，而不是整条被拒）。
 */

// ---------------------------------------------------------------------------
// 值域
// ---------------------------------------------------------------------------

/** 提交方法白名单：只开放可表达「一次请求拿结果」的方法。 */
export const CUSTOM_INTERFACE_FORMAT_SUBMIT_METHODS = ['POST', 'GET', 'PUT', 'PATCH'] as const;

export const CustomInterfaceFormatSubmitMethodSchema = z.enum(CUSTOM_INTERFACE_FORMAT_SUBMIT_METHODS);

export type CustomInterfaceFormatSubmitMethod = z.infer<typeof CustomInterfaceFormatSubmitMethodSchema>;

/**
 * 请求体形态：
 * - `json`：结构化 JSON 对象（默认）；
 * - `multipart`：表单文件上传（边界由运行时生成，`content_type` 必须为 `null`）；
 * - `form`：`application/x-www-form-urlencoded`（字段/数组的编码形态见 `form_*_style`）；
 * - `text`：整个请求体就是提示词纯文本（不允许请求体参数与素材位）。
 */
export const CUSTOM_INTERFACE_FORMAT_PAYLOAD_FORMATS = ['json', 'multipart', 'form', 'text'] as const;

export const CustomInterfaceFormatPayloadFormatSchema = z.enum(CUSTOM_INTERFACE_FORMAT_PAYLOAD_FORMATS);

export type CustomInterfaceFormatPayloadFormat = z.infer<typeof CustomInterfaceFormatPayloadFormatSchema>;

/** 表单编码的嵌套字段形态：`a.b=c`（dotted）或 `a[b]=c`（bracket）。 */
export const CUSTOM_INTERFACE_FORMAT_FORM_FIELD_STYLES = ['dotted', 'bracket'] as const;

export const CustomInterfaceFormatFormFieldStyleSchema = z.enum(CUSTOM_INTERFACE_FORMAT_FORM_FIELD_STYLES);

export type CustomInterfaceFormatFormFieldStyle = z.infer<typeof CustomInterfaceFormatFormFieldStyleSchema>;

/** 表单编码的数组形态：重复同名键（repeat）/ 方括号（bracket）/ 下标（index）。 */
export const CUSTOM_INTERFACE_FORMAT_FORM_ARRAY_STYLES = ['repeat', 'bracket', 'index'] as const;

export const CustomInterfaceFormatFormArrayStyleSchema = z.enum(CUSTOM_INTERFACE_FORMAT_FORM_ARRAY_STYLES);

export type CustomInterfaceFormatFormArrayStyle = z.infer<typeof CustomInterfaceFormatFormArrayStyleSchema>;

/** 鉴权注入形态：只声明「凭证注入到哪里」，不承载凭证。 */
export const CUSTOM_INTERFACE_FORMAT_AUTH_KINDS = ['bearer', 'header_api_key', 'query_api_key'] as const;

export const CustomInterfaceFormatAuthKindSchema = z.enum(CUSTOM_INTERFACE_FORMAT_AUTH_KINDS);

export type CustomInterfaceFormatAuthKind = z.infer<typeof CustomInterfaceFormatAuthKindSchema>;

/** 参数类型：与实体字段组件一一映射（string → text，number → number，boolean → switch，enum → select）。 */
export const CUSTOM_INTERFACE_FORMAT_PARAMETER_TYPES = ['string', 'number', 'boolean', 'enum'] as const;

export const CustomInterfaceFormatParameterTypeSchema = z.enum(CUSTOM_INTERFACE_FORMAT_PARAMETER_TYPES);

export type CustomInterfaceFormatParameterType = z.infer<typeof CustomInterfaceFormatParameterTypeSchema>;

/** 参数默认值：标量，与运行时参数合并层同一值域。 */
export const CustomInterfaceFormatParameterValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export type CustomInterfaceFormatParameterValue = z.infer<typeof CustomInterfaceFormatParameterValueSchema>;

// ---------------------------------------------------------------------------
// 请求落点（形状与名称规则在 interface-format-binding.ts，此处原样导出公开名）
// ---------------------------------------------------------------------------

/**
 * 请求体路径的公开名（历史名保留，形状与判定唯一实现在 `interface-format-binding.ts`）。
 *
 * `interfaceFormatBodyPathsOverlap` / `isRelativeSubmitPath` 由 contracts 的 barrel 从
 * `interface-format-binding.ts` 直接导出，不在此重复导出（同一名字两处导出会让 `export *` 歧义）。
 */
export const CUSTOM_INTERFACE_FORMAT_BODY_PATH_PATTERN = INTERFACE_FORMAT_BODY_PATH_PATTERN;
export const CustomInterfaceFormatBodyPathSchema = InterfaceFormatBodyPathSchema;

export const CustomInterfaceFormatBodyBindingSchema = InterfaceFormatBodyBindingSchema;
export const CustomInterfaceFormatQueryBindingSchema = InterfaceFormatQueryBindingSchema;
export const CustomInterfaceFormatHeaderBindingSchema = InterfaceFormatHeaderBindingSchema;
export const CustomInterfaceFormatValueBindingSchema = InterfaceFormatValueBindingSchema;
export const CustomInterfaceFormatPromptBindingSchema = InterfaceFormatPromptBindingSchema;
export const CustomInterfaceFormatModelBindingSchema = InterfaceFormatModelBindingSchema;

/** 固定请求头 / 固定查询参数的一对名称与值。 */
export const CustomInterfaceFormatNameValueSchema = InterfaceFormatNameValueSchema;

export type CustomInterfaceFormatNameValue = z.infer<typeof CustomInterfaceFormatNameValueSchema>;
export type CustomInterfaceFormatBodyBinding = z.infer<typeof CustomInterfaceFormatBodyBindingSchema>;
export type CustomInterfaceFormatQueryBinding = z.infer<typeof CustomInterfaceFormatQueryBindingSchema>;
export type CustomInterfaceFormatHeaderBinding = z.infer<typeof CustomInterfaceFormatHeaderBindingSchema>;
export type CustomInterfaceFormatValueBinding = InterfaceFormatValueBinding;
export type CustomInterfaceFormatPromptBinding = InterfaceFormatPromptBinding;
export type CustomInterfaceFormatModelBinding = InterfaceFormatModelBinding;

// ---------------------------------------------------------------------------
// 请求体形态的默认 Content-Type（Hub 预填与合成共用，避免各自硬编码）
// ---------------------------------------------------------------------------

const URL_ENCODED_FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const PLAIN_TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
const JSON_CONTENT_TYPE = 'application/json';

/**
 * 某个请求体形态在「用户没填 Content-Type」时应使用的值。
 *
 * `multipart` 返回 `null`：边界由运行时生成，固定 Content-Type 会把 boundary 写死。
 * 其余三种返回该形态的标准 MIME；`text` 带 `charset=utf-8`，因为正文是用户输入的提示词。
 */
export const defaultCustomInterfaceFormatContentType = (
  payloadFormat: CustomInterfaceFormatPayloadFormat,
): string | null => {
  switch (payloadFormat) {
    case 'json':
      return JSON_CONTENT_TYPE;
    case 'form':
      return URL_ENCODED_FORM_CONTENT_TYPE;
    case 'text':
      return PLAIN_TEXT_CONTENT_TYPE;
    case 'multipart':
      return null;
  }
};

/** 是否 `application/x-www-form-urlencoded`（允许带 charset 等参数，大小写不敏感）。 */
export const isUrlEncodedFormContentType = (value: string): boolean =>
  (value.split(';')[0] ?? '').trim().toLowerCase() === URL_ENCODED_FORM_CONTENT_TYPE;

// ---------------------------------------------------------------------------
// 冲突破判（唯一实现：草稿与实体校验共用同一套命名空间判据）
// ---------------------------------------------------------------------------

type WireBindingSummary =
  | { namespace: 'body'; path: string }
  | { namespace: 'query'; name: string }
  | { namespace: 'header'; name: string }
  | { namespace: 'text' }
  | { namespace: 'path' };

const summarizeBinding = (
  binding: InterfaceFormatValueBinding | InterfaceFormatPromptBinding | InterfaceFormatModelBinding,
): WireBindingSummary => {
  switch (binding.location) {
    case 'body':
      return { namespace: 'body', path: binding.path };
    case 'query':
      return { namespace: 'query', name: binding.name };
    case 'header':
      return { namespace: 'header', name: binding.name };
    case 'text':
      return { namespace: 'text' };
    case 'path':
      return { namespace: 'path' };
  }
};

/**
 * 两个落点是否冲突：命名空间相同才可能冲突。
 *
 * 请求体按「相等或互相包含」判（祖孙路径会写同一个对象）；查询参数按名称全等；
 * 请求头按名称大小写不敏感比较（HTTP 头名不区分大小写）。
 */
const bindingsConflict = (left: WireBindingSummary, right: WireBindingSummary): boolean => {
  if (left.namespace === 'body' && right.namespace === 'body') {
    return interfaceFormatBodyPathsOverlap(left.path, right.path);
  }
  if (left.namespace === 'query' && right.namespace === 'query') return left.name === right.name;
  if (left.namespace === 'header' && right.namespace === 'header') {
    return normalizeHeaderName(left.name) === normalizeHeaderName(right.name);
  }
  return false;
};

/** 名称/值列表校验（固定请求头与固定查询参数共用；`pathPrefix` 决定错误落点）。 */
const validateWireNameValueList = (
  entries: readonly { name: string; value: string }[],
  namespace: 'header' | 'query',
  pathPrefix: readonly (string | number)[],
  ctx: z.RefinementCtx,
): void => {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const nameValid = namespace === 'header'
      ? isValidHttpHeaderName(entry.name) && !isForbiddenRequestHeaderName(entry.name)
      : isValidQueryParamName(entry.name);
    if (!nameValid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          namespace === 'header'
            ? isForbiddenRequestHeaderName(entry.name)
              ? 'interface_format_header_name_forbidden'
              : 'interface_format_header_name_invalid'
            : 'interface_format_query_name_invalid',
        path: [...pathPrefix, index, 'name'],
      });
    }
    const valueValid = namespace === 'header'
      ? isValidHttpHeaderValue(entry.value)
      : isValidQueryParamValue(entry.value);
    if (!valueValid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          namespace === 'header'
            ? 'interface_format_header_value_invalid'
            : 'interface_format_query_value_invalid',
        path: [...pathPrefix, index, 'value'],
      });
    }
    const identity = namespace === 'header' ? normalizeHeaderName(entry.name) : entry.name;
    if (seen.has(identity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          namespace === 'header'
            ? 'interface_format_fixed_header_duplicated'
            : 'interface_format_fixed_query_duplicated',
        path: [...pathPrefix, index, 'name'],
      });
    }
    seen.add(identity);
  });
};

// ---------------------------------------------------------------------------
// 草稿段
// ---------------------------------------------------------------------------

/**
 * 凭证注入形态（判别联合，不承载凭证）：
 * - `bearer`：`<header_name>: <prefix> <secret>`；
 * - `header_api_key`：`<header_name>: <secret>`；
 * - `query_api_key`：`?<query_name>=<secret>`（与其它两种共用同一份连接凭证）。
 */
export const CustomInterfaceFormatSubmitAuthSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('bearer'),
      /** 凭证注入的请求头名（bearer 通常是 `Authorization`）。 */
      header_name: z.string().trim().min(1).max(80),
      /** scheme 文本（如 `Bearer`）。 */
      prefix: z.string().trim().min(1).max(40).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('header_api_key'),
      header_name: z.string().trim().min(1).max(80),
    })
    .strict(),
  z
    .object({
      kind: z.literal('query_api_key'),
      /** 凭证注入的查询参数名（如 `key`）。 */
      query_name: z.string().trim().min(1).max(80),
    })
    .strict(),
]);

export type CustomInterfaceFormatSubmitAuth = z.infer<typeof CustomInterfaceFormatSubmitAuthSchema>;

export const CustomInterfaceFormatSubmitDraftSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine(isRelativeSubmitPath, 'interface_format_submit_path_not_relative'),
    method: CustomInterfaceFormatSubmitMethodSchema,
    payload_format: CustomInterfaceFormatPayloadFormatSchema,
    /**
     * `null` = 不声明固定 Content-Type（multipart 由运行时按边界生成）。
     * `form` / `text` 省略时由 `defaultCustomInterfaceFormatContentType` 给出默认值。
     */
    content_type: z.string().trim().min(1).max(160).nullable().default(null),
    auth: CustomInterfaceFormatSubmitAuthSchema,
    /** 固定请求头：提交、轮询、取结果共用。名称不得是禁止头，也不得与鉴权头重名。 */
    headers: z.array(InterfaceFormatNameValueSchema).max(50).default([]),
    /** 固定查询参数：仅提交请求携带。 */
    query: z.array(InterfaceFormatNameValueSchema).max(50).default([]),
    /** `payload_format = 'form'` 时的嵌套字段编码形态。 */
    form_field_style: CustomInterfaceFormatFormFieldStyleSchema.default('dotted'),
    /** `payload_format = 'form'` 时的数组编码形态。 */
    form_array_style: CustomInterfaceFormatFormArrayStyleSchema.default('repeat'),
  })
  .strict()
  .superRefine((submit, ctx) => {
    validateWireNameValueList(submit.headers, 'header', ['headers'], ctx);
    validateWireNameValueList(submit.query, 'query', ['query'], ctx);
    if (submit.auth.kind === 'query_api_key') {
      if (!isValidQueryParamName(submit.auth.query_name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_query_name_invalid',
          path: ['auth', 'query_name'],
        });
      }
    } else if (!isValidHttpHeaderName(submit.auth.header_name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_header_name_invalid',
        path: ['auth', 'header_name'],
      });
    }
    if (
      submit.payload_format === 'form' &&
      submit.content_type !== null &&
      !isUrlEncodedFormContentType(submit.content_type)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_form_content_type_invalid',
        path: ['content_type'],
      });
    }
  });

export type CustomInterfaceFormatSubmitDraft = z.infer<typeof CustomInterfaceFormatSubmitDraftSchema>;

export const CustomInterfaceFormatParameterDraftSchema = z
  .object({
    /**
     * 该参数的发送落点：请求体路径（含点号表示嵌套，如 `options.size`）/ 查询参数名 / 请求头名。
     *
     * 三个命名空间分别查重：请求体按路径重叠、查询参数按名称全等、请求头按名称大小写不敏感。
     */
    binding: InterfaceFormatValueBindingSchema,
    /** 用户可见名称（Hub 表单里填的那一行）。 */
    label: z.string().trim().min(1).max(80),
    type: CustomInterfaceFormatParameterTypeSchema,
    required: z.boolean().default(false),
    default_value: CustomInterfaceFormatParameterValueSchema.optional(),
    /** `type = 'enum'` 时的候选值；其余类型忽略（写入侧按类型只取所需）。 */
    enum_values: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
  })
  .strict();

export type CustomInterfaceFormatParameterDraft = z.infer<typeof CustomInterfaceFormatParameterDraftSchema>;

/**
 * 素材位的输入载体（2026-10-26 B7）：
 * - `multipart_file`：作为表单文件上传（提交体必须是 multipart）；
 * - `public_url`：经公网中转后以 URL 放进请求体；
 * - `inline_data`：直接以 base64 data URL 放进 JSON 请求体。
 */
export const CUSTOM_INTERFACE_FORMAT_MEDIA_CARRIERS = [
  'multipart_file',
  'public_url',
  'inline_data',
] as const;

export const CustomInterfaceFormatMediaCarrierSchema = z.enum(CUSTOM_INTERFACE_FORMAT_MEDIA_CARRIERS);

export type CustomInterfaceFormatMediaCarrier = z.infer<typeof CustomInterfaceFormatMediaCarrierSchema>;

export const CustomInterfaceFormatMediaSlotDraftSchema = z
  .object({
    /** 受控素材位词表：决定输入端口的数据类型与表单组件。 */
    slot_id: GenerationMediaSlotIdSchema,
    /** 请求体路径（也作为参数字段键）；素材位只能发到请求体，不支持查询参数/请求头。 */
    field_key: CustomInterfaceFormatBodyPathSchema,
    label: z.string().trim().min(1).max(80),
    required: z.boolean().default(false),
    /** 一次提交最多可绑定的媒体条目数；缺省 1。 */
    max_files: z.number().int().min(1).max(50).default(1),
    carrier: CustomInterfaceFormatMediaCarrierSchema,
  })
  .strict();

export type CustomInterfaceFormatMediaSlotDraft = z.infer<typeof CustomInterfaceFormatMediaSlotDraftSchema>;

/** 异步任务的轮询声明（提交只拿标识，完成与产物从轮询响应读）。 */
export const CustomInterfaceFormatAsyncPollingDraftSchema = z
  .object({
    /** 轮询地址模板：相对路径，用 `{id}` 表示任务标识位置。 */
    path: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine(isRelativeSubmitPath, 'interface_format_polling_path_not_relative'),
    method: z.enum(['GET', 'POST']).default('GET'),
    /** 轮询请求附带的固定请求头（名称规则与提交段固定头一致）。 */
    headers: z.array(InterfaceFormatNameValueSchema).max(50).default([]),
    /** 轮询请求附带的查询参数。 */
    query: z.array(InterfaceFormatNameValueSchema).max(50).default([]),
    /** 轮询请求体（只有 POST 轮询允许携带；字符串里可用 `{id}` 等占位）。 */
    body: InterfaceFormatJsonValueSchema.optional(),
    /** 轮询请求体的形态；`form` 要求 body 是对象。 */
    body_format: z.enum(['json', 'form']).default('json'),
    /** 轮询请求体的 Content-Type；`form` 若填写必须是 form 编码。 */
    content_type: z.string().trim().min(1).max(160).nullable().default(null),
    /** 状态字段路径（响应体路径；同名响应头由求值器兜底）。 */
    status_path: z.string().trim().min(1).max(200),
    success_values: z.array(z.string().trim().min(1).max(160)).min(1).max(50),
    failure_values: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
    interval_ms: z.number().int().min(500).max(600000).default(10000),
    max_attempts: z.number().int().min(1).max(10000).default(300),
  })
  .strict()
  .superRefine((polling, ctx) => {
    validateWireNameValueList(polling.headers, 'header', ['headers'], ctx);
    validateWireNameValueList(polling.query, 'query', ['query'], ctx);
    if (polling.body !== undefined && polling.method !== 'POST') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_polling_body_requires_post',
        path: ['body'],
      });
    }
    if (polling.body_format === 'form') {
      if (
        polling.body !== undefined &&
        (polling.body === null || typeof polling.body !== 'object' || Array.isArray(polling.body))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_polling_form_body_must_be_object',
          path: ['body'],
        });
      }
      if (polling.content_type !== null && !isUrlEncodedFormContentType(polling.content_type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_form_content_type_invalid',
          path: ['content_type'],
        });
      }
    }
  });

export type CustomInterfaceFormatAsyncPollingDraft = z.infer<typeof CustomInterfaceFormatAsyncPollingDraftSchema>;

export const CustomInterfaceFormatAsyncDraftSchema = z
  .object({
    /** 提交响应里任务标识的路径（如 `id` / `data.id` / `name`）。 */
    identity_path: z.string().trim().min(1).max(200),
    polling: CustomInterfaceFormatAsyncPollingDraftSchema,
  })
  .strict();

export type CustomInterfaceFormatAsyncDraft = z.infer<typeof CustomInterfaceFormatAsyncDraftSchema>;

/** 本批允许的「成功条件」缺省：产物映射命中即视为成功（由 backend 合成）。 */
const BehaviorDraftSchema = z
  .object({
    /**
     * 成功判定。缺省由 backend 合成：
     * - 同步：产物字段存在即成功；
     * - 异步：轮询状态命中 `success_values` 即成功。
     */
    success_when: RecipeConditionSchema.optional(),
    failure_when: RecipeConditionSchema.optional(),
    failure_reason: z.string().trim().min(1).max(140).optional(),
    /** 结果形态：直接链接 / 内联内容 / 只给标识需再取一次。 */
    result: RecipeResultFormSchema,
    /** 产物地址（含再取一次的内容地址）是否需要带提交同源凭证。 */
    requires_auth: z.boolean().default(false),
    /** 声明轮询段即为异步；缺省即同步。 */
    async: CustomInterfaceFormatAsyncDraftSchema.optional(),
  })
  .strict()
  .superRefine((behavior, ctx) => {
    const result = behavior.result;
    if (result.kind !== 'needs_fetch') return;
    if (behavior.async === undefined) {
      // 同步提交没有轮询响应可读取标识；再取一次只在异步链路上成立。
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_needs_fetch_requires_async',
        path: ['result'],
      });
    }
    if (result.accept === 'binary' && result.media_type === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_needs_fetch_media_type_missing',
        path: ['result', 'media_type'],
      });
    }
    if (result.accept === 'json' && result.after === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_needs_fetch_after_missing',
        path: ['result', 'after'],
      });
    }
  });

export type CustomInterfaceFormatBehaviorDraft = z.infer<typeof BehaviorDraftSchema>;

export const CustomInterfaceFormatDraftSchema = z
  .object({
    /**
     * 格式 id。创建时可省略（backend 生成 `if_` 前缀 id）；更新时不可改（提交相同值也按「相同」处理，
     * 不同值由路由以 409 拒绝）。
     */
    format_id: InterfaceFormatIdSchema.optional(),
    display_name: z.string().trim().min(1).max(80),
    submit: CustomInterfaceFormatSubmitDraftSchema,
    /**
     * 产品 `model_id` 的落点：请求体路径 / 查询参数 / 地址路径（`{model}` 占位）。
     * 省略即请求不带 model_id。
     */
    model_binding: InterfaceFormatModelBindingSchema.optional(),
    parameters: z.array(CustomInterfaceFormatParameterDraftSchema).max(50).default([]),
    /** 素材位（图像 / 视频 / 音频输入）；缺省为空 = 纯文本模型。 */
    media_slots: z.array(CustomInterfaceFormatMediaSlotDraftSchema).max(20).default([]),
    /** 提示词的落点：请求体路径 / 查询参数 / 纯文本正文（`text`）。 */
    prompt_binding: InterfaceFormatPromptBindingSchema,
    behavior: BehaviorDraftSchema,
  })
  .strict()
  .superRefine((draft, ctx) => {
    const promptSummary = summarizeBinding(draft.prompt_binding);
    const parameterSummaries: WireBindingSummary[] = [];
    const modelSummary =
      draft.model_binding === undefined ? null : summarizeBinding(draft.model_binding);

    // 提示词落点与请求体形态必须互相对齐：纯文本正文只存在于 `payload_format = 'text'`。
    if (draft.submit.payload_format === 'text') {
      if (promptSummary.namespace !== 'text') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_text_payload_requires_text_prompt',
          path: ['prompt_binding'],
        });
      }
      if (draft.media_slots.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_text_payload_forbids_media_slots',
          path: ['media_slots'],
        });
      }
      // 纯文本正文里没有「请求体字段」，模型 ID 也就无处可放。
      if (modelSummary !== null && modelSummary.namespace === 'body') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_text_payload_forbids_body_fields',
          path: ['model_binding'],
        });
      }
    } else if (promptSummary.namespace === 'text') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_text_binding_requires_text_payload',
        path: ['prompt_binding'],
      });
    }

    draft.parameters.forEach((parameter, index) => {
      const summary = summarizeBinding(parameter.binding);
      if (
        summary.namespace === 'body' &&
        summary.path === MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_field_key_reserved',
          path: ['parameters', index, 'binding', 'path'],
        });
      }
      if (draft.submit.payload_format === 'text' && summary.namespace === 'body') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_text_payload_forbids_body_fields',
          path: ['parameters', index, 'binding'],
        });
      }
      if (parameterSummaries.some((existing) => bindingsConflict(existing, summary))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_parameter_key_duplicated',
          path: ['parameters', index, 'binding'],
        });
      }
      parameterSummaries.push(summary);
      if (parameter.type === 'enum' && (parameter.enum_values ?? []).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_parameter_enum_values_missing',
          path: ['parameters', index, 'enum_values'],
        });
      }
    });

    // 三个落点不能互相占位：同一命名空间下相等/包含就是同一份取值被写两次。
    if (parameterSummaries.some((summary) => bindingsConflict(summary, promptSummary))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_prompt_path_conflicts_with_parameter',
        path: ['prompt_binding'],
      });
    }

    if (modelSummary !== null) {
      if (modelSummary.namespace === 'path' && !draft.submit.path.includes('{model}')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_model_path_binding_requires_placeholder',
          path: ['model_binding'],
        });
      }
      if (
        bindingsConflict(modelSummary, promptSummary) ||
        parameterSummaries.some((summary) => bindingsConflict(summary, modelSummary))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_model_path_conflicts',
          path: ['model_binding'],
        });
      }
    }

    // 固定头 / 固定查询参数与「会动态取值」的落点不能撞名：同一个线路位置有两个来源。
    const authHeaderName = draft.submit.auth.kind === 'query_api_key'
      ? null
      : normalizeHeaderName(draft.submit.auth.header_name);
    const authQueryName = draft.submit.auth.kind === 'query_api_key'
      ? draft.submit.auth.query_name
      : null;
    draft.submit.headers.forEach((entry, index) => {
      const normalized = normalizeHeaderName(entry.name);
      const collidesWithParameter = parameterSummaries.some(
        (summary) => summary.namespace === 'header' && normalizeHeaderName(summary.name) === normalized,
      );
      if ((authHeaderName !== null && normalized === authHeaderName) || collidesWithParameter) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_fixed_header_conflicts',
          path: ['submit', 'headers', index, 'name'],
        });
      }
    });
    const dynamicQueryNames = new Set<string>();
    for (const summary of [...parameterSummaries, promptSummary]) {
      if (summary.namespace === 'query') dynamicQueryNames.add(summary.name);
    }
    if (modelSummary !== null && modelSummary.namespace === 'query') {
      dynamicQueryNames.add(modelSummary.name);
    }
    draft.submit.query.forEach((entry, index) => {
      if ((authQueryName !== null && entry.name === authQueryName) || dynamicQueryNames.has(entry.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_fixed_query_conflicts',
          path: ['submit', 'query', index, 'name'],
        });
      }
    });

    // 路径里写死的查询参数同样会与上述三种来源撞名（同一个键出现两次）。
    const fixedQueryNames = new Set(draft.submit.query.map((entry) => entry.name));
    for (const name of extractQueryParamNamesFromPath(draft.submit.path)) {
      if (
        fixedQueryNames.has(name) ||
        dynamicQueryNames.has(name) ||
        (authQueryName !== null && name === authQueryName)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_submit_path_query_conflicts',
          path: ['submit', 'path'],
        });
      }
    }

    // 素材位：位标识与请求体路径都不能重复；路径也不能占用提示词/参数/模型身份的位置。
    const slotIds = new Set<string>();
    const slotFieldKeys: string[] = [];
    const bodyParameterPaths = parameterSummaries
      .filter((summary) => summary.namespace === 'body')
      .map((summary) => summary.path);
    const promptBodyPath = promptSummary.namespace === 'body' ? promptSummary.path : null;
    const modelBodyPath =
      modelSummary !== null && modelSummary.namespace === 'body' ? modelSummary.path : null;
    draft.media_slots.forEach((slot, index) => {
      if (slotIds.has(slot.slot_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_media_slot_duplicated',
          path: ['media_slots', index, 'slot_id'],
        });
      }
      slotIds.add(slot.slot_id);
      if (slot.field_key === MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_field_key_reserved',
          path: ['media_slots', index, 'field_key'],
        });
      }
      if (
        slotFieldKeys.some((existing) => interfaceFormatBodyPathsOverlap(existing, slot.field_key)) ||
        bodyParameterPaths.some((existing) => interfaceFormatBodyPathsOverlap(existing, slot.field_key)) ||
        (promptBodyPath !== null && interfaceFormatBodyPathsOverlap(slot.field_key, promptBodyPath)) ||
        (modelBodyPath !== null && interfaceFormatBodyPathsOverlap(slot.field_key, modelBodyPath))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_media_field_key_conflicts',
          path: ['media_slots', index, 'field_key'],
        });
      }
      slotFieldKeys.push(slot.field_key);
      if (slot.carrier === 'multipart_file' && draft.submit.payload_format !== 'multipart') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_multipart_slot_requires_multipart_submit',
          path: ['media_slots', index, 'carrier'],
        });
      }
      if (slot.carrier === 'multipart_file' && draft.submit.content_type !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_multipart_slot_requires_null_content_type',
          path: ['submit', 'content_type'],
        });
      }
      if (slot.carrier === 'inline_data' && slot.max_files > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_inline_slot_single_file_only',
          path: ['media_slots', index, 'max_files'],
        });
      }
    });

    // 轮询路径的静态查询串：与轮询段自己的查询参数、鉴权 query 名撞名同样拒绝。
    const polling = draft.behavior.async?.polling;
    if (polling !== undefined) {
      const pollingQueryNames = new Set(polling.query.map((entry) => entry.name));
      for (const name of extractQueryParamNamesFromPath(polling.path)) {
        if (pollingQueryNames.has(name) || (authQueryName !== null && name === authQueryName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'interface_format_polling_path_query_conflicts',
            path: ['behavior', 'async', 'polling', 'path'],
          });
        }
      }
    }
  });

export type CustomInterfaceFormatDraft = z.infer<typeof CustomInterfaceFormatDraftSchema>;

// ---------------------------------------------------------------------------
// 请求 / 响应体
// ---------------------------------------------------------------------------

export const CustomInterfaceFormatCreateBodySchema = CustomInterfaceFormatDraftSchema;

export type CustomInterfaceFormatCreateBody = z.infer<typeof CustomInterfaceFormatCreateBodySchema>;

/**
 * 更新请求体：与创建同一形状。
 *
 * `format_id` 保留在请求体里不是为了改它（路由会以 409 拒绝不同值），而是让「先 GET 再 PUT」
 * 的客户端能把读到的完整草稿原样提交；缺省即「不改 id」。
 */
export const CustomInterfaceFormatUpdateBodySchema = CustomInterfaceFormatDraftSchema;

export type CustomInterfaceFormatUpdateBody = z.infer<typeof CustomInterfaceFormatUpdateBodySchema>;

/**
 * 创建 / 更新响应：合成的实体身份 + 自动生成的判定配方 + 与详情端点同一份只读投影。
 *
 * `detail` 复用 `InterfaceFormatDetailSchema`：Hub 保存后不需要再发一次详情请求，且展示口径
 * 与列表页同源（不另立字段事实源）。
 */
export const CustomInterfaceFormatWriteResponseSchema = z
  .object({
    format_id: InterfaceFormatIdSchema,
    recipe_id: InterfaceRecipeIdSchema,
    detail: InterfaceFormatDetailSchema,
  })
  .strict();

export type CustomInterfaceFormatWriteResponse = z.infer<typeof CustomInterfaceFormatWriteResponseSchema>;

/**
 * 复制接口格式的响应（`POST /api/interface-formats/:formatId/copy`）。
 *
 * 复制是**服务端整实体克隆**：新格式的传输 / 参数 / 素材位 / 投影 / 内置行为 / 合成段 / 文案
 * 全部来自源格式，不经过草稿重新合成。`recipe_id` 为 `null` 表示没有可靠派生出判定与结果
 * 形态（例如内置映射只在响应里给出一个路径，无法判断它是链接还是内联内容）——此时 Hub 应
 * 打开编辑器让用户补全，而不是把「没有判定」当成「格式不可用」。
 */
export const CustomInterfaceFormatCopyResponseSchema = z
  .object({
    format_id: InterfaceFormatIdSchema,
    recipe_id: InterfaceRecipeIdSchema.nullable(),
    detail: InterfaceFormatDetailSchema,
  })
  .strict();

export type CustomInterfaceFormatCopyResponse = z.infer<typeof CustomInterfaceFormatCopyResponseSchema>;

export const CustomInterfaceFormatRemovalResponseSchema = z
  .object({ removed_format_id: InterfaceFormatIdSchema })
  .strict();

export type CustomInterfaceFormatRemovalResponse = z.infer<typeof CustomInterfaceFormatRemovalResponseSchema>;
