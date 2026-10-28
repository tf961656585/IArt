import {
  AdapterAuthSchema,
  GenerationMediaSlotIdSchema,
  InterfaceFormatNameValueSchema,
  extractQueryParamNamesFromPath,
  isForbiddenRequestHeaderName,
  isUrlEncodedFormContentType,
  isValidHttpHeaderName,
  isValidQueryParamName,
  normalizeHeaderName,
  parseInterfaceFormatRuleTarget,
} from '@iart/contracts';
import { z } from 'zod';

/**
 * 「接口格式」实体（interface format）的只读声明 schema。
 *
 * 背景：2026-10-26 起「接口类型 → 协议语义」的事实已从
 * `generation-family-templates.<family>.cts` 的 TypeScript 工厂迁到接口格式实体，
 * 生产消费方经 `generation-family-templates.registry.cts` 门面访问（旧族文件已于 2026-10-26 删除）。
 * 接口格式实体把**可由数据表达的部分**收敛成一份随软件分发的只读 JSON：
 * 传输（提交路径 / 方法 / 请求体形态 / 鉴权形状 / 任务标识 / 轮询地址与节奏）、参数 schema、
 * 素材位、节点投影、文案、合成规则。行为（成功/失败判定、结果形态、产物路径、下载鉴权）仍归
 * 接口配方所有，但**预设格式可携带只读「内置行为」段**，作为没有配方时的默认。
 *
 * 边界：
 * - 本 schema 只描述数据形状与格式内部的一致性；「合成后的请求规则是否被执行链接受」由
 *   合成产物走既有投影校验（下一批迁移消费方时接上），不在本批范围内。
 * - **请求规则只有一个来源**：`transport.payload_rules` 是 `runtime.payload_rules` 的完整
 *   规则树，逐键照搬族构建器的产物；合成器不再按参数表 / 素材位 / 投影段自动推导任何一条
 *   规则（endpoint、method、Content-Type、请求头、model、提示词、参数发出键、`meta.*` 全部
 *   显式写在树里）。素材位条件分支由合成期宏表达（见 `macros.cts`）。
 * - `.strict()` 遍布每个结构对象：预设是人工维护的 JSON，拼错的键名必须当场报错，不能静默
 *   变成「这条配置没生效」。
 * - 自由形态的段落（参数 schema、请求规则、投影扩展）用 `InterfaceFormatJsonValueSchema`
 *   承载：它们本身就是既有运行时的 JSON 事实，本实体只做搬运、占位符替换与宏求值，不复制
 *   其内部字段事实源。
 */

/**
 * 实体 schema 版本（结构演进时进位；不兼容变更必须进位）。
 */
export const INTERFACE_FORMAT_SCHEMA_VERSION = 1;

/**
 * 格式 id 字符集：小写字母/数字开头，后续允许 `.` `_` `-`。
 *
 * 与 contracts 的 `InterfaceFormatIdSchema`（记录字段的值域）逐字符一致：id 是预设文件、
 * manifest、用户记录（`family_adapter_id`）、URL 段与投影命名空间的共同键，放宽字符集会
 * 把这些外部键带进非法文件名/URL 段。
 */
export const INTERFACE_FORMAT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** 自由形态 JSON 值（搬运既有运行时 JSON，不做结构约束）。 */
export type InterfaceFormatJsonValue =
  | string
  | number
  | boolean
  | null
  | InterfaceFormatJsonValue[]
  | { [key: string]: InterfaceFormatJsonValue };

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

export const InterfaceFormatJsonObjectSchema: z.ZodType<Record<string, InterfaceFormatJsonValue>> = z.record(
  z.string(),
  InterfaceFormatJsonValueSchema,
);

/** 自由形态 JSON 对象（`InterfaceFormatJsonObjectSchema` 的推导类型，供合成侧标注中间结构）。 */
export type InterfaceFormatJsonObject = Record<string, InterfaceFormatJsonValue>;

/** JSON 值 → 对象视图（数组与标量返回 null）；只服务实体内部的结构性读取，不做字段校验。 */
const asJsonObject = (value: InterfaceFormatJsonValue | undefined): InterfaceFormatJsonObject | null =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;

const IdentifierSchema = z.string().regex(INTERFACE_FORMAT_ID_PATTERN, 'interface_format_id_invalid');

/**
 * endpoint 键字符集（接口格式自己的命名空间，不是路径）。
 *
 * 与 `format_id` 的小写字符集**刻意不同**：这些键是适配器 `relative_endpoints` 的键名
 * （`taskById` / `predictLongRunning` / `imageToVideo`），逐字照搬适配器契约才能让「格式声明
 * 的端点」与「适配器登记的端点」按同一份键对齐；早期版本套用 id 正则把 camelCase 挡在门外，
 * 迫使预设另起一套小写键名，多了一层无意义的翻译。
 */
export const INTERFACE_FORMAT_ENDPOINT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;

const EndpointKeySchema = z
  .string()
  .regex(INTERFACE_FORMAT_ENDPOINT_KEY_PATTERN, 'interface_format_endpoint_key_invalid');

// ---------------------------------------------------------------------------
// 传输段
// ---------------------------------------------------------------------------

/**
 * 鉴权形状：只声明「凭证注入到哪里」，不承载任何凭证。
 *
 * 直接复用 contracts 的 `AdapterAuthSchema`（值域 owner）：实体 → 执行快照的鉴权形状必须与
 * 契约逐字段一致，另写一份会让新增鉴权形态在实体侧静默缺失。三种形态：
 * `bearer`（`Authorization: <prefix> <secret>`）/ `header_api_key`（自定义头名）/
 * `query_api_key`（查询参数，2026-10-27 起）。真正的注入由执行链
 * `buildAdapterAuthInjection` 完成。
 */
const TransportAuthSchema = AdapterAuthSchema;

/**
 * 轮询节奏、地址与请求。
 *
 * `endpoint_key` 与 `url_template` 互斥且必居其一：前者引用 `endpoints` 里的相对路径（推荐，
 * 路径单源），后者用于无法提前枚举的地址（保留 `{id}` 占位）。两者同时出现会让「请求到底打
 * 哪个地址」出现二义，直接拒绝。
 *
 * `headers` / `query` / `body` 是轮询请求声明的额外内容：字符串值允许 `{id}` / `{taskId}` /
 * `{requestId}` / `{operation_name}` / `{taskType}` 占位，由运行时替换（本层不做转义校验）。
 */
const TransportPollingSchema = z
  .object({
    endpoint_key: EndpointKeySchema.optional(),
    url_template: z.string().min(1).optional(),
    method: z.enum(['GET', 'POST']),
    headers: z.array(InterfaceFormatNameValueSchema).max(50).default([]),
    query: z.array(InterfaceFormatNameValueSchema).max(50).default([]),
    /** 只有 POST 轮询允许携带请求体。 */
    body: InterfaceFormatJsonValueSchema.optional(),
    body_format: z.enum(['json', 'form']).default('json'),
    content_type: z.string().min(1).max(160).nullable().default(null),
    interval_ms: z.number().int().positive(),
    max_attempts: z.number().int().positive(),
  })
  .strict()
  .refine((value) => (value.endpoint_key === undefined) !== (value.url_template === undefined), {
    message: 'interface_format_polling_target_ambiguous',
  })
  .superRefine((polling, ctx) => {
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

/** 异步任务段：任务标识在响应里的路径 + 轮询规则。同步格式不声明。 */
const TransportAsyncSchema = z
  .object({
    identity_path: z.string().min(1),
    polling: TransportPollingSchema,
  })
  .strict();

/**
 * 提交段（基线形态）。
 *
 * `api_defaults`（`runtime.api_defaults`）与缺省的 `request_strategy` 从这里生成；**请求规则
 * 本身不从这里生成**——完整规则树写在 `transport.payload_rules`。
 *
 * `response_id_path` 是提交响应里任务标识的路径（同步格式在既有实现里也保留该声明，
 * 异步格式与 `async.identity_path` 同值）。
 *
 * 固定请求头与固定查询参数**不在本段**：它们是两条（或多条）显式规则，写在
 * `transport.payload_rules` 的 `api.headers.<name>` / `api.query.<name>` 上，与参数/提示词的
 * 动态落点共用同一棵规则树——请求规则只有一个来源。
 */
const TransportSubmitSchema = z
  .object({
    endpoint_key: EndpointKeySchema,
    method: z.string().min(1),
    /** `null` = 该分支没有 Content-Type（multipart 由运行时按边界生成）。 */
    content_type: z.string().min(1).nullable(),
    payload_format: z.enum(['json', 'multipart', 'form', 'text']),
    /**
     * `form` 形态的嵌套字段 / 数组编码方式（2026-10-27 起）。
     *
     * 给默认值是必需的：预设文件与既有用户库都没有这两个键，缺默认值会让整份格式解析失败
     * （等于内置格式全部消失）。默认值与草稿契约同值。
     */
    form_field_style: z.enum(['dotted', 'bracket']).default('dotted'),
    form_array_style: z.enum(['repeat', 'bracket', 'index']).default('repeat'),
    /** 条件判定形态的 payload_format（不可从 submit 静态表达的格式才声明）。 */
    payload_format_rule: InterfaceFormatJsonValueSchema.optional(),
    response_id_path: z.string().min(1).optional(),
  })
  .strict();

const TransportSchema = z
  .object({
    auth: TransportAuthSchema,
    /** endpoint 键 → 相对路径。键是 `declaredEndpointKeys` 的取值域。 */
    endpoints: z.record(EndpointKeySchema, z.string().min(1)),
    submit: TransportSubmitSchema,
    async: TransportAsyncSchema.optional(),
    /**
     * **完整请求规则树**（`runtime.payload_rules` 的唯一来源）。
     *
     * 逐键照搬族构建器的 `payload_rules`：`api.endpoint` / `api.method` / `api.contentType` /
     * `api.headers.*` / `api.query.*` / `body.*` / `meta.*` 与顶层 `prompt` / `input` 回显都必须
     * 显式写在这里，合成器不再按参数表或素材位自动补任何一条。允许 `{{...}}` 占位符与合成期宏（见
     * `macros.cts`）：素材位条件分支用宏表达，同一棵树在「接受某位 / 不接受」两种记录上
     * 分别产出各自应有的规则。
     */
    payload_rules: InterfaceFormatJsonObjectSchema,
    /**
     * 完整请求策略树（`runtime.request_strategy`）。缺省时按 `submit` 生成今天各族的静态形状
     * （`request_stage: submit` / `protocol: http` / `endpoint` / `method` / 三个空规则数组）。
     * 允许占位符与宏。
     */
    request_strategy: InterfaceFormatJsonObjectSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// 参数段
// ---------------------------------------------------------------------------

/**
 * 提示词字段。
 *
 * 只承载字段身份与校验：提示词发到哪里、要不要同时回显到顶层系统键（`prompt` / `input`）
 * 都由 `transport.payload_rules` 显式声明——接线事实只有一个来源。
 * 输出的 `prompt_field` 段只保留 `field_key` / `required` / `validation_rules`。
 */
const PromptFieldSchema = z
  .object({
    field_key: z.string().min(1),
    required: z.boolean(),
    validation_rules: InterfaceFormatJsonValueSchema,
  })
  .strict();

const ParametersSchema = z
  .object({
    /**
     * parameter_schema 基线：**不含素材位字段**（素材位行由 `media` 生成并前置）。
     * `default_values` 不由这里承载——`defaults` 是唯一事实源，合成期同时写入
     * `parameter_schema.default_values` 与 `runtime.schema_defaults`。
     */
    schema: InterfaceFormatJsonObjectSchema,
    defaults: InterfaceFormatJsonObjectSchema,
    prompt_field: PromptFieldSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// 素材位段
// ---------------------------------------------------------------------------

/**
 * 素材位的**接线身份**（能力维度）。
 *
 * 素材位字段的显示设置与输入端口在 `composition.fragments[slotId]` 里声明；**请求规则不在这里
 * 生成**——它写在 `transport.payload_rules` 里（可用宏按素材位是否被接受分支）。拆成两处是
 * 为了让「该模板能表达哪几位、字段键叫什么、最多几张」集中一处（与注册表条目同形），
 * 而「这位具体怎么上 wire」由完整规则树表达。
 */
const MediaSlotSchema = z
  .object({
    field_key: z.string().min(1),
    component: z.string().min(1),
    /** 发出键名（仅展示与保留键用途；不再据此生成请求规则）。 */
    wire_name: z.string().min(1).optional(),
    max_files: z.number().int().min(1).optional(),
  })
  .strict();

const MediaSchema = z
  .object({
    supports: z.array(GenerationMediaSlotIdSchema),
    required: z.array(GenerationMediaSlotIdSchema),
    slots: z.record(GenerationMediaSlotIdSchema, MediaSlotSchema),
  })
  .strict()
  .refine(
    (value) => {
      const slotIds = Object.keys(value.slots);
      if (slotIds.length !== value.supports.length) return false;
      const supported = new Set<string>(value.supports);
      return slotIds.every((slotId) => supported.has(slotId));
    },
    { message: 'interface_format_media_slots_mismatch' },
  )
  .refine((value) => value.required.every((slotId) => value.supports.includes(slotId)), {
    message: 'interface_format_media_required_not_supported',
  });

// ---------------------------------------------------------------------------
// 投影段
// ---------------------------------------------------------------------------

/**
 * 执行档：`task_type` 同时是 `default_task_type` 与 `mode`（既有一族一份实现里三者恒同值，
 * 由 schema 收成单值避免三处漂移）。
 */
const ExecutionProfileSchema = z
  .object({
    task_type: z.string().min(1),
    supports_async_task: z.boolean(),
  })
  .strict();

const ProjectionNodeSchema = z
  .object({
    node_type: z.string().min(1),
    output_ports: z.array(InterfaceFormatJsonObjectSchema).min(1),
  })
  .strict();

/** 素材位输入的公网中转目标（旧形态；与 `runtime_extras` 走同一条合并路径）。 */
const UrlInputUploadSchema = z
  .object({
    mode: z.string().min(1),
    target_type: z.string().min(1),
  })
  .strict();

const ProjectionSchema = z
  .object({
    provider_id: z.string().min(1),
    group_key: z.string().min(1),
    /** 能力声明（允许合成期宏：能力字段随已接受素材位派生）。 */
    capability: InterfaceFormatJsonObjectSchema,
    execution_profile: ExecutionProfileSchema,
    display: InterfaceFormatJsonObjectSchema,
    workspace: InterfaceFormatJsonObjectSchema,
    execution_driver: z.string().min(1),
    url_input_upload: UrlInputUploadSchema.optional(),
    /**
     * 并入 `runtime` 的额外键（允许合成期宏）。
     *
     * 典型用法：`url_input_upload_mode` / `url_input_upload_target_type` 只在确实带素材位时
     * 声明（用 `$any_slot_present` 包裹，未带素材位时整键被 `$OMIT` 掉）；`payload_format_rule`
     * 与 `payload_format` 互斥，合并时出现前者会删掉后者（运行时只认一个请求体形态声明）。
     */
    runtime_extras: InterfaceFormatJsonObjectSchema.optional(),
    node: ProjectionNodeSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// 内置行为段（等价于今天族模板里的判定 / 结果段）
// ---------------------------------------------------------------------------

/**
 * 轮询状态词表（内置默认）。
 *
 * 路径均为数组：既有轮询策略按顺序逐个路径求值（`statusFieldPaths`），单路径是它的退化形态。
 */
const PollingStatusSchema = z
  .object({
    status_paths: z.array(z.string().min(1)).min(1),
    success_values: z.array(z.string().min(1)).min(1),
    failure_values: z.array(z.string().min(1)),
    /**
     * 成功判据的额外路径（如「结果地址已出现」）：某些异步上游在状态词之外还有一份就绪
     * 信号，缺省不写该键（不是空数组）。
     */
    success_field_paths: z.array(z.string().min(1)).optional(),
    failure_code_paths: z.array(z.string().min(1)).optional(),
    failure_message_paths: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * 只读「内置行为」段：没有接口配方时的默认判定与结果形态。
 *
 * 有配方时仍然先落这一段（配方只覆盖 `success_condition` / `failure_condition` /
 * `result_output_mapping` / 获取策略），因此 `mode` 与 `submit_response_id_path` 永远来自格式。
 * `result_rule` 不承载 `submit_response_id_path`——它由 `transport` 的提交/异步段生成。
 */
const BuiltinBehaviorSchema = z
  .object({
    result_rule: InterfaceFormatJsonObjectSchema,
    polling_status: PollingStatusSchema.optional(),
    result_output_mapping: InterfaceFormatJsonObjectSchema,
    result_acquisition: InterfaceFormatJsonObjectSchema.optional(),
  })
  .strict()
  .refine((value) => !('submit_response_id_path' in value.result_rule), {
    message: 'interface_format_result_rule_owns_submit_response_id_path',
  });

// ---------------------------------------------------------------------------
// 合成段
// ---------------------------------------------------------------------------

/** 单个素材位的接线片段：字段显示设置与画布输入端口（请求规则归 `transport.payload_rules`）。 */
const SlotFragmentSchema = z
  .object({
    /** 参数字段体（不含 field_key / component，合成期注入）。`default_value` 会并入参数默认表。 */
    schema_field: InterfaceFormatJsonObjectSchema,
    /** 画布输入端口体（`field_key` 与 `multiple` 由合成期注入）。 */
    input_port: InterfaceFormatJsonObjectSchema,
  })
  .strict();

/**
 * 组合变体：当列出的素材位全部被接受时，把 `patch` 深合并到合成源上。
 *
 * patch 是**源级**形状（`runtimeModel` / `node` / `localizationResources`），语义：
 * - 对象递归合并；数组整体替换；
 * - `null` 删除该键；
 * - 带 `kind` 判别字段的规则节点视为原子值，整体替换（规则节点内部的 `null` 是字面量
 *   「不发这个字段」，不是删除标记）。
 */
const VariantSchema = z
  .object({
    when: z.object({ slots_present: z.array(GenerationMediaSlotIdSchema).min(1) }).strict(),
    patch: InterfaceFormatJsonObjectSchema,
  })
  .strict();

const CompositionSchema = z
  .object({
    fragments: z.record(GenerationMediaSlotIdSchema, SlotFragmentSchema),
    variants: z.array(VariantSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// 文案段
// ---------------------------------------------------------------------------

const LocalizationSchema = z
  .object({
    'zh-CN': InterfaceFormatJsonObjectSchema,
    en: InterfaceFormatJsonObjectSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// 实体
// ---------------------------------------------------------------------------

export const InterfaceFormatSchema = z
  .object({
    schema_version: z.literal(INTERFACE_FORMAT_SCHEMA_VERSION),
    format_id: IdentifierSchema,
    version: z.string().min(1),
    display_name: z.string().min(1),
    family: z.literal('generation'),
    origin: z.enum(['preset', 'user']),
    status: z.enum(['ready', 'pending']),
    order: z.number().int().nonnegative(),
    transport: TransportSchema,
    parameters: ParametersSchema,
    media: MediaSchema,
    projection: ProjectionSchema,
    builtin_behavior: BuiltinBehaviorSchema.optional(),
    composition: CompositionSchema,
    localization: LocalizationSchema,
  })
  .strict()
  .superRefine((format, ctx) => {
    const endpointKeys = new Set(Object.keys(format.transport.endpoints));
    if (!endpointKeys.has(format.transport.submit.endpoint_key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_submit_endpoint_unknown',
        path: ['transport', 'submit', 'endpoint_key'],
      });
    }
    const pollingEndpointKey = format.transport.async?.polling.endpoint_key;
    if (pollingEndpointKey !== undefined && !endpointKeys.has(pollingEndpointKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_polling_endpoint_unknown',
        path: ['transport', 'async', 'polling', 'endpoint_key'],
      });
    }

    const slotIds = Object.keys(format.media.slots).sort();
    const fragmentIds = Object.keys(format.composition.fragments).sort();
    const fragmentsMatchSlots =
      slotIds.length === fragmentIds.length && slotIds.every((slotId, index) => slotId === fragmentIds[index]);
    if (!fragmentsMatchSlots) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_fragments_mismatch',
        path: ['composition', 'fragments'],
      });
    }

    format.composition.variants.forEach((variant, index) => {
      for (const slotId of variant.when.slots_present) {
        if (slotId in format.media.slots) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_variant_slot_unknown',
          path: ['composition', 'variants', index, 'when', 'slots_present'],
        });
      }
    });

    // 素材位字段键必须与基线参数字段、以及彼此之间都不重名：合成期素材位字段前置并以其
    // default_value 进默认表，重名会静默顶掉一条基线参数（没有任何报错）。
    const baseFieldKeys = new Set<string>();
    const rawFields = format.parameters.schema.fields;
    if (Array.isArray(rawFields)) {
      for (const rawField of rawFields) {
        if (rawField === null || typeof rawField !== 'object' || Array.isArray(rawField)) continue;
        const fieldKey = rawField.field_key;
        if (typeof fieldKey === 'string') baseFieldKeys.add(fieldKey);
      }
    }
    const seenSlotFieldKeys = new Set<string>();
    for (const slot of Object.values(format.media.slots)) {
      if (baseFieldKeys.has(slot.field_key) || seenSlotFieldKeys.has(slot.field_key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_media_field_key_conflict',
          path: ['media', 'slots', slot.field_key],
        });
      }
      seenSlotFieldKeys.add(slot.field_key);
    }

    // -----------------------------------------------------------------------
    // 请求落点：线路名称合法性、鉴权与规则冲突、路径静态查询串、text 分支
    // -----------------------------------------------------------------------

    const auth = format.transport.auth;
    const authHeaderName = auth.kind === 'query_api_key' ? null : normalizeHeaderName(auth.header_name);
    const authQueryName = auth.kind === 'query_api_key' ? auth.query_name : null;
    if (auth.kind === 'query_api_key' && !isValidQueryParamName(auth.query_name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_query_name_invalid',
        path: ['transport', 'auth', 'query_name'],
      });
    }

    const ruleQueryNames = new Set<string>();
    for (const target of Object.keys(format.transport.payload_rules)) {
      const parsed = parseInterfaceFormatRuleTarget(target);
      if (parsed.kind === 'header') {
        if (!isValidHttpHeaderName(parsed.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'interface_format_header_name_invalid',
            path: ['transport', 'payload_rules', target],
          });
        } else if (isForbiddenRequestHeaderName(parsed.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'interface_format_header_name_forbidden',
            path: ['transport', 'payload_rules', target],
          });
        }
        if (authHeaderName !== null && normalizeHeaderName(parsed.name) === authHeaderName) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'interface_format_rule_conflicts_with_auth_header',
            path: ['transport', 'payload_rules', target],
          });
        }
        continue;
      }
      if (parsed.kind !== 'query') continue;
      if (!isValidQueryParamName(parsed.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_query_name_invalid',
          path: ['transport', 'payload_rules', target],
        });
      }
      ruleQueryNames.add(parsed.name);
      if (authQueryName !== null && parsed.name === authQueryName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_rule_conflicts_with_auth_query',
          path: ['transport', 'payload_rules', target],
        });
      }
    }

    // 路径里写死的查询参数与规则树/鉴权声明的查询参数重名 → 同一个键出现两次。
    const submitPath = format.transport.endpoints[format.transport.submit.endpoint_key];
    if (submitPath !== undefined) {
      for (const name of extractQueryParamNamesFromPath(submitPath)) {
        if (ruleQueryNames.has(name) || (authQueryName !== null && name === authQueryName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'interface_format_submit_path_query_conflicts',
            path: ['transport', 'submit', 'endpoint_key'],
          });
        }
      }
    }
    const polling = format.transport.async?.polling;
    if (polling !== undefined) {
      const pollingPath =
        polling.url_template ??
        (polling.endpoint_key === undefined ? undefined : format.transport.endpoints[polling.endpoint_key]);
      if (pollingPath !== undefined) {
        const pollingQueryNames = new Set(polling.query.map((entry) => entry.name));
        for (const name of extractQueryParamNamesFromPath(pollingPath)) {
          if (pollingQueryNames.has(name) || (authQueryName !== null && name === authQueryName)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'interface_format_polling_path_query_conflicts',
              path: ['transport', 'async', 'polling'],
            });
          }
        }
      }
    }

    // `text`：整个正文就是提示词——不允许请求体字段（含素材位），且必须有一条 `body` 规则
    // 把提示词字段放进正文。请求体参数只能走查询参数 / 请求头（规则树里不得出现 `body.*`）。
    if (format.transport.submit.payload_format === 'text') {
      if (format.media.supports.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_text_payload_forbids_media_slots',
          path: ['media', 'supports'],
        });
      }
      for (const target of Object.keys(format.transport.payload_rules)) {
        if (parseInterfaceFormatRuleTarget(target).kind !== 'body_field') continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_text_payload_forbids_body_fields',
          path: ['transport', 'payload_rules', target],
        });
      }
      const textRule = asJsonObject(format.transport.payload_rules.body);
      const textRuleIsPrompt =
        textRule !== null &&
        textRule.kind === 'field' &&
        textRule.field_key === format.parameters.prompt_field.field_key;
      if (!textRuleIsPrompt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interface_format_text_payload_requires_prompt_rule',
          path: ['transport', 'payload_rules'],
        });
      }
    } else if ('body' in format.transport.payload_rules) {
      // 非 text 形态下 `body` 目标会把整个请求体替换成标量，与任何其它规则都无法共存。
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_body_text_rule_requires_text_payload',
        path: ['transport', 'payload_rules'],
      });
    }

    if (
      format.transport.submit.payload_format === 'form' &&
      format.transport.submit.content_type !== null &&
      !isUrlEncodedFormContentType(format.transport.submit.content_type)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interface_format_form_content_type_invalid',
        path: ['transport', 'submit', 'content_type'],
      });
    }
  });

/** 预设清单：随软件分发的入口表（本批只登记一条，结构按 8 条设计）。 */
export const InterfaceFormatManifestSchema = z
  .object({
    schema_version: z.literal(INTERFACE_FORMAT_SCHEMA_VERSION),
    formats: z.array(
      z
        .object({
          format_id: IdentifierSchema,
          /** 加载顺序（升序）；展示顺序用实体自己的 `order`。 */
          order: z.number().int().nonnegative(),
          file: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type InterfaceFormat = z.infer<typeof InterfaceFormatSchema>;
export type InterfaceFormatManifest = z.infer<typeof InterfaceFormatManifestSchema>;
export type InterfaceFormatMediaSlot = z.infer<typeof MediaSlotSchema>;
export type InterfaceFormatSlotFragment = z.infer<typeof SlotFragmentSchema>;
export type InterfaceFormatVariant = z.infer<typeof VariantSchema>;
export type InterfaceFormatBuiltinBehavior = z.infer<typeof BuiltinBehaviorSchema>;
