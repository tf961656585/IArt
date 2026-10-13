import * as z from 'zod';
import type {
  ModelAssetNodeProjectionRuntimeMeta,
} from './runtime-dsl';
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY, MODEL_ASSET_SUPPORTED_LOCALES } from './protocol-constants';

// ---------------------------------------------------------------------------
// Leaf schemas (no dependencies on other schemas defined in this file)
// ---------------------------------------------------------------------------

const imageSizeConstrainedResolutionPresetOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
});

/** 自定义 W×H 模式的常见宽高预设；value 即提交值（'WxH'，如 '1024x1024'），不接受 auto。 */
const imageSizeConstrainedResolutionCustomPresetSchema = z.object({
  value: z
    .string()
    .regex(/^\d+x\d+$/, 'custom preset value must be "WxH"'),
  label: z.string().optional(),
  description: z.string().optional(),
});

const imageSizeConstrainedResolutionSizeLevelSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  /** 级别语义：总像素预算（如 1K = 1024² = 1048576），不再是长边像素 */
  pixelBudget: z.number().int().positive(),
});

const imageSizeConstrainedResolutionAspectPresetSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  ratio: z.number().positive(),
});

const imageSizeConstrainedResolutionConstraintsSchema = z.object({
  dimensionMultiple: z.number().int().positive(),
  maxLongEdge: z.number().int().positive(),
  minPixels: z.number().positive(),
  maxPixels: z.number().positive(),
  maxAspectRatio: z.number().positive(),
}).refine((value) => value.maxPixels >= value.minPixels, {
  message: 'maxPixels must be greater than or equal to minPixels',
});

const dynamicMapSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  const componentProps = value as { mode: unknown | undefined };
  if (componentProps.mode !== 'constrainedResolution') return;
  const parsed = ModelAssetImageSizeConstrainedResolutionComponentPropsSchema.safeParse(value);
  if (parsed.success) return;
  parsed.error.issues.forEach((issue) => {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: issue.path,
      message: issue.message,
    });
  });
});

const dynamicListSchema = z.array(dynamicMapSchema);

const dataTypeSchema = z.enum(['text', 'image', 'video', 'audio', 'url', 'any']);
const fieldComponentSchema = z.enum([
  'text',
  'textarea',
  'select',
  'switch',
  'number',
  'radio',
  'toggle',
  'file',
  'imageUpload',
  'imageSize',
]);
const fieldDataSourceSchema = z.enum(['connection', 'form', 'both']);
const visibleWhenOpSchema = z.enum(['eq', 'neq', 'in', 'not_in']);

export const ModelAssetNodeProjectionVisibleWhenSchema = z.object({
  field: z.string(),
  op: visibleWhenOpSchema,
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]),
});

const nodeRoleSchema = z.enum(['generator', 'processor']);
export const ModelAssetLocaleSchema = z.enum(MODEL_ASSET_SUPPORTED_LOCALES);

const runtimeMetaSchema = z.custom<ModelAssetNodeProjectionRuntimeMeta>(
  (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
);

// ---------------------------------------------------------------------------
// Composite schemas (depend on leaf schemas or other composite schemas)
// ---------------------------------------------------------------------------

export const ModelAssetImageSizeConstrainedResolutionComponentPropsSchema = z.object({
  mode: z.literal('constrainedResolution'),
  allowAuto: z.boolean().optional(),
  sizeLevels: z.array(imageSizeConstrainedResolutionSizeLevelSchema).optional(),
  aspectPresets: z.array(imageSizeConstrainedResolutionAspectPresetSchema).optional(),
  presetOptions: z.array(imageSizeConstrainedResolutionPresetOptionSchema).optional(),
  customPresets: z.array(imageSizeConstrainedResolutionCustomPresetSchema).optional(),
  constraints: imageSizeConstrainedResolutionConstraintsSchema,
}).passthrough();

export const ModelAssetNodeProjectionPortSchema = z.object({
  id: z.string(),
  name: z.string(),
  data_type: dataTypeSchema,
  field_key: z.string(),
  required: z.boolean().optional(),
  multiple: z.boolean().optional(),
  max_connections: z.number().optional(),
  description: z.string().optional(),
  visible_when: ModelAssetNodeProjectionVisibleWhenSchema.optional(),
});

export const ModelAssetNodeProjectionPortsSchema = z.object({
  inputs: z.array(ModelAssetNodeProjectionPortSchema),
  outputs: z.array(ModelAssetNodeProjectionPortSchema),
});

export const ModelAssetNodeProjectionCapabilitySchema = z.object({
  input_modalities: z.array(z.string()),
  output_modalities: z.array(z.string()),
  supports_async_task: z.boolean(),
  supports_streaming: z.boolean().optional(),
  supports_multi_image: z.boolean().optional(),
  supports_reference_media: z.boolean().optional(),
  constraints: dynamicListSchema.optional(),
});

export const ModelAssetNodeProjectionValidationRuleSchema = z.object({
  type: z.string(),
  value: z.unknown().optional(),
  message: z.string().optional(),
});

export const ModelAssetNodeProjectionEnumOptionSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  label: z.string().optional(),
});

export const ModelAssetNodeProjectionParameterFieldSchema = z.object({
  field_key: z.string(),
  label: z.string(),
  description: z.string().optional(),
  component: fieldComponentSchema,
  component_props: dynamicMapSchema.optional(),
  data_source: fieldDataSourceSchema.optional().default('form'),
  required: z.boolean(),
  default_value: z.unknown().optional(),
  enum_options: z.array(ModelAssetNodeProjectionEnumOptionSchema).optional(),
  validation_rules: z.array(ModelAssetNodeProjectionValidationRuleSchema).optional(),
  layout: dynamicMapSchema.optional(),
  visible_when: ModelAssetNodeProjectionVisibleWhenSchema.optional(),
  metadata: dynamicMapSchema.optional(),
});

// ---------------------------------------------------------------------------
// Variant group schemas
// ---------------------------------------------------------------------------

export const VariantGroupVariantSchema = z.object({
  model_id: z.string(),
  shell_model_id: z.string().optional(),
  // Display-compatible duplicate of model_id; variant selectors render model_id directly.
  label: z.string(),
  order: z.number(),
  payload_overrides: z.record(z.string(), z.unknown()).optional(),
});

export const VariantGroupSchema = z.object({
  group_key: z.string(),
  shell_model_id: z.string(),
  default_model_id: z.string(),
  variants: z.array(VariantGroupVariantSchema),
});

export const ModelAssetNodeProjectionModeParameterOverrideSchema = z.object({
  visibility: z.enum(['visible', 'hidden']).optional(),
  required: z.boolean().optional(),
  default_value: z.unknown().optional(),
});

export const ModelAssetNodeProjectionModeSchema = z.object({
  key: z.string(),
  label: z.string(),
  parameter_overrides: z.record(ModelAssetNodeProjectionModeParameterOverrideSchema),
});

export const ModelAssetNodeProjectionModesSchema = z.array(ModelAssetNodeProjectionModeSchema);

export const ModelAssetNodeProjectionParameterSchemaSchema = z.object({
  schema_type: z.literal('object'),
  fields: z.array(ModelAssetNodeProjectionParameterFieldSchema),
  required_fields: z.array(z.string()),
  default_values: dynamicMapSchema,
  validation_rules: z.array(ModelAssetNodeProjectionValidationRuleSchema),
});

export const ModelAssetNodeProjectionExecutionProfileSchema = z.object({
  task_type: z.string(),
  supports_async_task: z.boolean(),
});

export const ModelAssetNodeProjectionVisibilitySchema = z.object({
  visible: z.boolean(),
  order: z.number(),
  badges: z.array(z.string()).optional(),
});

/**
 * 提示词映射字段声明（方案 B：从 parameter_schema 参数清单中剥离的专用映射声明）。
 *
 * `field_key` 固定为保留键 `__prompt`（MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY）——它只存在于
 * 参数合并空间（payload 暂存），永远不进入参数表单、不参与参数校验；`required` 与
 * `validation_rules`（max_length / min_length 等）表达提示词自身的约束，供 Editor 提示词
 * 长度守卫消费。缺省/undefined = 该模型不消费提示词（TTS、suno 音频等）。
 */
export const ModelAssetNodeProjectionPromptFieldSchema = z.object({
  field_key: z.literal(MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY),
  required: z.boolean(),
  validation_rules: z.array(ModelAssetNodeProjectionValidationRuleSchema),
});

export type ModelAssetNodeProjectionPromptField = z.infer<typeof ModelAssetNodeProjectionPromptFieldSchema>;

export const ModelAssetNodeProjectionSchema = z.object({
  package_id: z.string().optional(),
  model_id: z.string(),
  display_label: z.string().optional(),
  shell_model_id: z.string().optional(),
  node_type: z.literal('model'),
  role: nodeRoleSchema.optional(),
  description: z.string().optional(),
  group_key: z.string(),
  icon_ref: z.string().optional(),
  capability: ModelAssetNodeProjectionCapabilitySchema,
  ports: ModelAssetNodeProjectionPortsSchema,
  parameter_schema: ModelAssetNodeProjectionParameterSchemaSchema,
  /**
   * 提示词映射字段声明（字段键固定为保留键 `__prompt`，不进参数表单）。
   * 模型能力包的 payload_rules 引用该键暂存提示词；缺省表示该模型不消费提示词。
   */
  prompt_field: ModelAssetNodeProjectionPromptFieldSchema.optional(),
  execution_profile: ModelAssetNodeProjectionExecutionProfileSchema,
  visibility: ModelAssetNodeProjectionVisibilitySchema,
  runtime: runtimeMetaSchema.optional(),
  modes: ModelAssetNodeProjectionModesSchema.optional(),
  variant_group: VariantGroupSchema.optional(),
});

export const ModelAssetPackageDiagnosticSchema = z.object({
  package_id: z.string(),
  model_id: z.string().optional(),
  code: z.string(),
  message: z.string(),
});

export const ModelAssetLocalizationBundleSchema = z.object({
  package_id: z.string(),
  namespace: z.string(),
  resources: z.object({
    'zh-CN': z.record(z.unknown()),
    en: z.record(z.unknown()),
  }),
});

export const ModelAssetNodeProjectionResponseSchema = z.object({
  success: z.boolean(),
  loaded_at: z.string(),
  package_root: z.string(),
  projections: z.array(ModelAssetNodeProjectionSchema),
  localization_bundles: z.array(ModelAssetLocalizationBundleSchema),
  diagnostics: z.array(ModelAssetPackageDiagnosticSchema),
});

// ---------------------------------------------------------------------------
// Derived types — single source of truth from Zod schemas
// ---------------------------------------------------------------------------

export type ModelAssetProjectionDynamicMap = z.infer<typeof dynamicMapSchema>;
export type ModelAssetProjectionDynamicList = z.infer<typeof dynamicListSchema>;

export type ModelAssetNodeProjectionPort = z.infer<typeof ModelAssetNodeProjectionPortSchema>;
export type ModelAssetNodeProjectionPorts = z.infer<typeof ModelAssetNodeProjectionPortsSchema>;
export type ModelAssetNodeProjectionCapability = z.infer<typeof ModelAssetNodeProjectionCapabilitySchema>;
export type ModelAssetNodeProjectionValidationRule = z.infer<typeof ModelAssetNodeProjectionValidationRuleSchema>;

export type ModelAssetImageSizeComponentMode = 'constrainedResolution';

export type ModelAssetImageSizeConstrainedResolutionPresetOption = z.infer<typeof imageSizeConstrainedResolutionPresetOptionSchema>;
export type ModelAssetImageSizeConstrainedResolutionSizeLevel = z.infer<typeof imageSizeConstrainedResolutionSizeLevelSchema>;
export type ModelAssetImageSizeConstrainedResolutionAspectPreset = z.infer<typeof imageSizeConstrainedResolutionAspectPresetSchema>;
export type ModelAssetImageSizeConstrainedResolutionConstraints = z.infer<typeof imageSizeConstrainedResolutionConstraintsSchema>;
export type ModelAssetImageSizeConstrainedResolutionComponentProps = z.infer<typeof ModelAssetImageSizeConstrainedResolutionComponentPropsSchema>;

export type ModelAssetNodeProjectionEnumOption = z.infer<typeof ModelAssetNodeProjectionEnumOptionSchema>;
export type ModelAssetNodeProjectionFieldDataSource = z.infer<typeof fieldDataSourceSchema>;
export type ModelAssetNodeProjectionParameterField = z.infer<typeof ModelAssetNodeProjectionParameterFieldSchema>;
export type ModelAssetNodeProjectionParameterSchema = z.infer<typeof ModelAssetNodeProjectionParameterSchemaSchema>;
export type ModelAssetNodeProjectionExecutionProfile = z.infer<typeof ModelAssetNodeProjectionExecutionProfileSchema>;
export type ModelAssetNodeProjectionVisibility = z.infer<typeof ModelAssetNodeProjectionVisibilitySchema>;
export type ModelAssetNodeProjectionVisibleWhen = z.infer<typeof ModelAssetNodeProjectionVisibleWhenSchema>;
export type ModelAssetNodeProjectionModeParameterOverride = z.infer<typeof ModelAssetNodeProjectionModeParameterOverrideSchema>;
export type ModelAssetNodeProjectionMode = z.infer<typeof ModelAssetNodeProjectionModeSchema>;

export type VariantGroupVariant = z.infer<typeof VariantGroupVariantSchema>;
export type VariantGroup = z.infer<typeof VariantGroupSchema>;

export type ModelAssetLocalizationResourceMap = Record<string, unknown>;
export type ModelAssetLocalizationBundle = z.infer<typeof ModelAssetLocalizationBundleSchema>;

export type ModelAssetNodeProjection = z.infer<typeof ModelAssetNodeProjectionSchema>;
export type ModelAssetPackageDiagnostic = z.infer<typeof ModelAssetPackageDiagnosticSchema>;
export type ModelAssetNodeProjectionResponse = z.infer<typeof ModelAssetNodeProjectionResponseSchema>;
