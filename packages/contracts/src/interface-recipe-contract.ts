import { z } from 'zod';

/**
 * 接口配方（Interface Recipe）契约：判定与结果形态的数据化载体。
 *
 * 设计事实源：`docs/custom-providers/接口配方-design.md`。
 *
 * 职责边界（不得越界）：
 * - 配方承载「怎么算轮询成功 / 失败」「成功的产物以什么形式返回」「产物地址是否需要鉴权」；
 * - 配方不承载 endpoint、请求方法、请求头、请求体、鉴权注入形态与阶段关系——那些属于协议族模板；
 * - 配方绑定一个已登记的协议族（`family_adapter_id`），不得跨族复用；
 * - 参数仍由既有参数覆盖层承载，两条链路互不读取。
 *
 * 存储形态与消费形态：
 * - 配方落 `config/interface-recipes.json`（公共库，跨连接共享；2026-10-24 拍板 D1）；
 * - 模型记录以可选 `recipe_id` 引用；缺省即使用该族模板的内置默认（零预置，2026-10-24 拍板 D3）；
 * - 运行时在合成投影期把配方合入族模板 sources，执行计划形态不变（执行快照唯一事实源）。
 */

// ---------------------------------------------------------------------------
// 标识
// ---------------------------------------------------------------------------

/** 配方 id 字符集：与模型记录 id 同一规则（进 URL 路径与日志）。 */
export const INTERFACE_RECIPE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export const InterfaceRecipeIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(INTERFACE_RECIPE_ID_PATTERN);

/** 配方名称：用户可见，仅做长度约束（不做字符集限制，允许中文）。 */
export const InterfaceRecipeNameSchema = z.string().trim().min(1).max(80);

// ---------------------------------------------------------------------------
// 判定条件树
// ---------------------------------------------------------------------------

/**
 * 条件标量：条件树只承载三种标量比较；数组/对象值不开放（与参数覆盖层的值域口径一致）。
 */
export const RecipeConditionScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);

export type RecipeConditionScalar = z.infer<typeof RecipeConditionScalarSchema>;

/**
 * 原子操作。
 *
 * 前九个沿用既有结果判定语言（`docs/model-assets/06-结果判定规则.md`）；
 * `gt/gte/lt/lte` 是本设计新增的数值比较原语——没有它，「进度达到 100」这类完成判据
 * 只能退化成「等于某个值」，无法表达阈值语义。
 */
export const RECIPE_ATOM_OPS = [
  'exists',
  'missing',
  'empty',
  'not_empty',
  'eq',
  'neq',
  'in',
  'not_in',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
] as const;

export const RecipeAtomOpSchema = z.enum(RECIPE_ATOM_OPS);

export type RecipeAtomOp = z.infer<typeof RecipeAtomOpSchema>;

/** 需要 value 的操作；其余操作只读路径。写入侧据此校验，schema 只管形状。 */
export const RECIPE_ATOM_OPS_REQUIRING_VALUE: ReadonlySet<RecipeAtomOp> = new Set([
  'eq',
  'neq',
  'in',
  'not_in',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
]);

/** 需要数组值的操作。 */
export const RECIPE_ATOM_OPS_REQUIRING_ARRAY_VALUE: ReadonlySet<RecipeAtomOp> = new Set([
  'in',
  'not_in',
]);

export type RecipeCondition =
  | { op: 'all'; children: RecipeCondition[] }
  | { op: 'any'; children: RecipeCondition[] }
  | { op: 'not'; condition: RecipeCondition }
  | {
      op: RecipeAtomOp;
      path: string;
      value?: RecipeConditionScalar | RecipeConditionScalar[];
    };

const RECIPE_MAX_CONDITION_DEPTH = 8;
const RECIPE_MAX_CONDITION_NODES = 64;

/**
 * 条件树 schema（递归）。
 *
 * 跨字段不变量（组合节点必须非空、原子操作必须带 path、需要 value 的操作必须带 value）
 * 按仓库纪律**不写成 schema refine**——历史文件里一条不一致会让整条配方在读取时被静默
 * 丢弃。这里只管形状，语义校验由 Runtime Backend 的配方校验器唯一实现（保存与合成共用）。
 */
export const RecipeConditionSchema: z.ZodType<RecipeCondition> = z.lazy(() =>  z.union([
    z
      .object({
        op: z.literal('all'),
        children: z.array(RecipeConditionSchema),
      })
      .strict(),
    z
      .object({
        op: z.literal('any'),
        children: z.array(RecipeConditionSchema),
      })
      .strict(),
    z
      .object({
        op: z.literal('not'),
        condition: RecipeConditionSchema,
      })
      .strict(),
    z
      .object({
        op: RecipeAtomOpSchema,
        path: z.string().min(1),
        value: z
          .union([RecipeConditionScalarSchema, z.array(RecipeConditionScalarSchema)])
          .optional(),
      })
      .strict(),
  ]),
) as z.ZodType<RecipeCondition>;

export const RECIPE_CONDITION_LIMITS = {
  maxDepth: RECIPE_MAX_CONDITION_DEPTH,
  maxNodes: RECIPE_MAX_CONDITION_NODES,
} as const;

// ---------------------------------------------------------------------------
// 结果形态（判别联合：三形态互斥，不用一堆可选字段）
// ---------------------------------------------------------------------------

export const RECIPE_MEDIA_TYPES = ['image', 'video', 'audio'] as const;
export const RecipeMediaTypeSchema = z.enum(RECIPE_MEDIA_TYPES);
export type RecipeMediaType = z.infer<typeof RecipeMediaTypeSchema>;

/**
 * 内联内容编码方式：
 * - `data_url`：字段值已是 `data:<mime>;base64,...`
 * - `json_inline`：字段值是 `{ data, mime_type? }` 形态的内联块
 * - `raw_base64`：字段值是裸 base64，需要按 `media_type`（或显式 `mime_type`）补前缀
 */
export const RECIPE_INLINE_ENCODINGS = ['data_url', 'json_inline', 'raw_base64'] as const;
export const RecipeInlineEncodingSchema = z.enum(RECIPE_INLINE_ENCODINGS);
export type RecipeInlineEncoding = z.infer<typeof RecipeInlineEncodingSchema>;

/** 直接返回链接。 */
export const RecipeDirectUrlResultSchema = z
  .object({
    kind: z.literal('direct_url'),
    media_field_paths: z.array(z.string().min(1)).min(1),
    media_type: RecipeMediaTypeSchema,
  })
  .strict();

/** 直接返回内容。 */
export const RecipeInlineMediaResultSchema = z
  .object({
    kind: z.literal('inline_media'),
    media_field_paths: z.array(z.string().min(1)).min(1),
    media_type: RecipeMediaTypeSchema,
    encoding: RecipeInlineEncodingSchema,
    /** `raw_base64` 且无法从媒体类型推断时使用；其余编码忽略。 */
    mime_type: z.string().min(1).optional(),
  })
  .strict();

/** 轮询响应里可直接消费的两种形态（needs_fetch 取回响应后按这两种解读）。 */
export const RecipeDirectResultSchema = z.union([
  RecipeDirectUrlResultSchema,
  RecipeInlineMediaResultSchema,
]);

export type RecipeDirectResult = z.infer<typeof RecipeDirectResultSchema>;

/**
 * 需要再取一次：轮询终态只给标识，产物在另一个地址。
 *
 * 只开放地址模板（GET + 同源鉴权），不开放请求方法/请求头/请求体——那是协议层。
 * `content_url_template` 必须含 `{id}` 占位符（写入侧校验）。
 */
export const RecipeNeedsFetchResultSchema = z
  .object({
    kind: z.literal('needs_fetch'),
    /** 从轮询响应里取标识的路径。 */
    identity_field_path: z.string().min(1),
    /** 最终结果地址模板，例如 `/v1/videos/{id}/content`。 */
    content_url_template: z.string().min(1),
    /** 最终结果接口的响应形态：`binary` 直接是媒体字节流，`json` 是结构化载荷。 */
    accept: z.enum(['binary', 'json']),
    /** `accept = binary` 时必填，用于落盘扩展名与媒体类型判定。 */
    media_type: RecipeMediaTypeSchema.optional(),
    /** `accept = json` 时必填，说明取回响应里产物在哪。 */
    after: RecipeDirectResultSchema.optional(),
  })
  .strict();

export type RecipeNeedsFetchResult = z.infer<typeof RecipeNeedsFetchResultSchema>;

export const RecipeResultFormSchema = z.union([
  RecipeDirectUrlResultSchema,
  RecipeInlineMediaResultSchema,
  RecipeNeedsFetchResultSchema,
]);

export type RecipeResultForm = z.infer<typeof RecipeResultFormSchema>;

// ---------------------------------------------------------------------------
// 配方实体
// ---------------------------------------------------------------------------

export const InterfaceRecipeSchema = z
  .object({
    recipe_id: InterfaceRecipeIdSchema,
    name: InterfaceRecipeNameSchema,
    /** 绑定的协议族；创建后不可改（改族等于换配方身份）。 */
    family_adapter_id: z.string().min(1),
    /** 成功判定（必填）。先判失败、再判成功、都不命中即继续等待。 */
    success_when: RecipeConditionSchema,
    /** 失败判定（可选）；命中即收口失败。 */
    failure_when: RecipeConditionSchema.optional(),
    /**
     * 失败判定命中时展示给用户的失败原因（可选）。
     *
     * 用户可读的一句话，不是内部错误码：任务失败提示优先用它，缺省才回落既有文案。
     * 只对 `failure_when` 命中生效——没有失败判定时该字段不参与判定。
     */
    failure_reason: z.string().trim().min(1).max(140).optional(),
    /** 结果形态（必填）。 */
    result: RecipeResultFormSchema,
    /** 产物地址 / 最终结果地址是否需要带提交同源凭证。 */
    requires_auth: z.boolean().default(false),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

export type InterfaceRecipe = z.infer<typeof InterfaceRecipeSchema>;

// ---------------------------------------------------------------------------
// 跨进程 DTO
// ---------------------------------------------------------------------------

export const InterfaceRecipeListResponseSchema = z
  .object({ recipes: z.array(InterfaceRecipeSchema) })
  .strict();

export type InterfaceRecipeListResponse = z.infer<typeof InterfaceRecipeListResponseSchema>;

export const InterfaceRecipeResponseSchema = z
  .object({ recipe: InterfaceRecipeSchema })
  .strict();

export type InterfaceRecipeResponse = z.infer<typeof InterfaceRecipeResponseSchema>;

export const InterfaceRecipeRemovalResponseSchema = z
  .object({ removed_recipe_id: InterfaceRecipeIdSchema })
  .strict();

export type InterfaceRecipeRemovalResponse = z.infer<typeof InterfaceRecipeRemovalResponseSchema>;

const RecipeConditionBodySchema = RecipeConditionSchema;

export const InterfaceRecipeCreateBodySchema = z
  .object({
    recipe_id: InterfaceRecipeIdSchema.optional(),
    name: InterfaceRecipeNameSchema,
    family_adapter_id: z.string().min(1),
    success_when: RecipeConditionBodySchema,
    failure_when: RecipeConditionBodySchema.optional(),
    failure_reason: z.string().trim().min(1).max(140).optional(),
    result: RecipeResultFormSchema,
    requires_auth: z.boolean().optional(),
  })
  .strict();

export type InterfaceRecipeCreateBody = z.infer<typeof InterfaceRecipeCreateBodySchema>;

export const InterfaceRecipeUpdateBodySchema = z
  .object({
    name: InterfaceRecipeNameSchema.optional(),
    success_when: RecipeConditionBodySchema.optional(),
    /**
     * 失败判定。语义：**缺省 = 保持现有；`null` = 清除失败判定；条件树 = 替换**。
     * 只给 optional 无法表达「清空」，三态是必需的（与记录侧 `recipe_id` 同口径）。
     */
    failure_when: RecipeConditionBodySchema.nullable().optional(),
    /**
     * 失败原因。语义与 `failure_when` 同口径：**缺省 = 保持现有；`null` = 清除；文本 = 替换**。
     */
    failure_reason: z.string().trim().min(1).max(140).nullable().optional(),
    result: RecipeResultFormSchema.optional(),
    requires_auth: z.boolean().optional(),
  })
  .strict();

export type InterfaceRecipeUpdateBody = z.infer<typeof InterfaceRecipeUpdateBodySchema>;

// ---------------------------------------------------------------------------
// 样本试跑（保存前自证规则）
// ---------------------------------------------------------------------------

/**
 * 试跑请求：用户贴一段真实查询响应，系统用与运行时同一套求值逻辑回答
 * 「判为成功 / 失败 / 继续等待」，以及抽取到的产物。
 *
 * 试跑纯本地计算，不发任何网络请求。
 */
export const InterfaceRecipeDryRunBodySchema = z
  .object({
    /** 样本响应体（JSON 值；允许用户贴字符串形式，由实现侧统一解析）。 */
    sample: z.unknown(),
    /** 可选：样本响应头，用于状态在响应头里的服务商。 */
    headers: z.record(z.string()).optional(),
    /** 可选：待试跑的配方草稿；缺省用已保存的配方。 */
    draft: InterfaceRecipeCreateBodySchema.partial().optional(),
  })
  .strict();

export type InterfaceRecipeDryRunBody = z.infer<typeof InterfaceRecipeDryRunBodySchema>;

export const RecipeDryRunVerdictSchema = z.enum(['success', 'failure', 'pending']);

export const InterfaceRecipeDryRunResponseSchema = z
  .object({
    verdict: RecipeDryRunVerdictSchema,
    /** 命中的条件路径与值，供用户核对「我填的字段确实被读到了」。 */
    matched: z.array(
      z
        .object({
          path: z.string(),
          value: z.unknown(),
        })
        .strict(),
    ),
    /** 试跑抽取到的产物（可能为空）。 */
    outputs: z.array(
      z
        .object({
          media_type: z.string(),
          url: z.string().optional(),
          text_value: z.string().optional(),
          source_path: z.string(),
        })
        .strict(),
    ),
    /** 未命中的候选路径（不存在或为空的路径），用于「字段可能填错」提示。 */
    unseen_paths: z.array(z.string()),
  })
  .strict();

export type InterfaceRecipeDryRunResponse = z.infer<typeof InterfaceRecipeDryRunResponseSchema>;

// ---------------------------------------------------------------------------
// 响应样本路径发现
// ---------------------------------------------------------------------------

/**
 * 路径发现：把一段样本响应里所有可用字段路径与取值展开，供用户点选填入判定/产物路径。
 * 该能力不做自动判定——判定始终由用户确认。
 */
export const RECIPE_PATH_DISCOVERY_MAX_PATHS = 500;

export const InterfaceRecipePathDiscoveryBodySchema = z
  .object({
    sample: z.unknown(),
  })
  .strict();

export const InterfaceRecipePathDiscoveryResponseSchema = z
  .object({
    paths: z.array(
      z
        .object({
          path: z.string(),
          value: z.unknown(),
          value_kind: z.enum(['string', 'number', 'boolean', 'null', 'array', 'object']),
        })
        .strict(),
    ),
  })
  .strict();

export type InterfaceRecipePathDiscoveryResponse = z.infer<
  typeof InterfaceRecipePathDiscoveryResponseSchema
>;
