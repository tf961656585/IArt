import type { DynamicRecord, UnknownRecord } from "@/client/utils/typeGuards";
import type { CSSProperties } from "react";
import type { SchemaGenerationPayload } from "@/client/types/generation";
import type { PromptUpdateCommand } from "../modelFormTypes";
import type { ImageResizeMode, ImageValidationConstraints } from '@iart/contracts/media/imageValidationTypes';
import type { ModelAssetMediaTargetShape } from "@iart/contracts/model-asset-contract";
import type {
  SchemaImageSizeAspectOption,
  SchemaImageSizeConstrainedAspectPreset,
  SchemaImageSizeConstrainedResolutionConstraints,
  SchemaImageSizeLevelOption,
  SchemaImageSizeOption,
  SchemaImageSizePresetOption,
} from "./imageSizeTypes";

export type {
  SchemaImageSizeAspectOption,
  SchemaImageSizeConstrainedAspectPreset,
  SchemaImageSizeConstrainedResolutionConstraints,
  SchemaImageSizeLevelOption,
  SchemaImageSizeOption,
  SchemaImageSizePresetOption,
} from "./imageSizeTypes";

export type SchemaFieldKey = string;

export type SchemaTranslateArgs =
  | [key: string | undefined]
  | [key: string | undefined, arg2: string | DynamicRecord | undefined];

export type SchemaTranslate = (...args: SchemaTranslateArgs) => string;

export type SchemaFieldType =
  | "text"
  | "textarea"
  | "select"
  | "radio"
  | "switch"
  | "toggle"
  | "tags"
  | "number"
  | "slider"
  | "file"
  | "imageUpload"
  | "imageSize"
  | "shotList"
  | "group"
  | "divider";

/**
 * Dock 呈现模式 - 控制字段在 Dock（紧凑模式）中的渲染方式
 * - inline: 直接渲染（默认，适合 select/switch 等紧凑字段）
 * - popover: 点击按钮弹出完整 UI（适合 imageSize 等复合字段）
 * - hidden: 在 Dock 中隐藏
 * - summary: 只显示值摘要
 */
export type SchemaDockPresentation = "inline" | "popover" | "hidden" | "summary";

export type SchemaFormValues<FieldKey extends string = SchemaFieldKey> = DynamicRecord<unknown, FieldKey>;

export interface SchemaFormMeta {
  id: string;
  version: string;
  modelId: string;
  titleKey: string | undefined;
  descriptionKey: string | undefined;
  docLinkKey: string | undefined;
}

export interface SchemaFormDefinition<FieldKey extends string = SchemaFieldKey> {
  meta: SchemaFormMeta;
  fields: Array<SchemaFieldDefinition<FieldKey>>;
  layout: SchemaFormLayout<FieldKey> | undefined;
  defaults: Partial<Record<FieldKey, unknown>> | undefined;
  formValidators: SchemaFormLevelValidator<FieldKey>[] | undefined;
  prompt: SchemaPromptConfig<FieldKey> | undefined;
  payload: SchemaPayloadDefinition<FieldKey>;
  responseHandling: SchemaResponseHandlingConfig | undefined;
}

export interface SchemaFormLayout<FieldKey extends string = SchemaFieldKey> {
  sections: SchemaFormSection<FieldKey>[] | undefined;
  stickyFooter: boolean | undefined;
  /**
   * 表单网格列数（md+ 断点生效）。
   * 支持 1~10 列，超出范围的数值在渲染时会被夹取。
   */
  columns: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | undefined;
}

export interface SchemaFormSection<FieldKey extends string = SchemaFieldKey> {
  id: string;
  titleKey: string | undefined;
  descriptionKey: string | undefined;
  fields: FieldKey[] | undefined;
  visibleWhen: SchemaCondition<FieldKey> | undefined;
  /**
   * 分区级网格列数（md+ 断点生效）。
   * 支持 1~10 列，超出范围的数值在渲染时会被夹取。
   */
  columns: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | undefined;
}

export interface SchemaFormLevelValidator<FieldKey extends string = SchemaFieldKey> {
  id: string | undefined;
  messageKey: string | undefined;
  when: SchemaCondition<FieldKey> | undefined;
  validate: (
    values: SchemaFormValues<FieldKey>,
    context: SchemaValidationContext<FieldKey>
  ) => string | null | Promise<string | null>;
}

export interface SchemaValidationContext<FieldKey extends string = SchemaFieldKey> {
  field: FieldKey | undefined;
  schema: SchemaFormDefinition<FieldKey>;
  values: SchemaFormValues<FieldKey>;
  modelId: string;
}

export interface SchemaResponseHandlingConfig {
  autoRetry: boolean | undefined;
  taskListSlot: "left" | "right" | "bottom" | undefined;
}

export type SchemaFieldDefinition<FieldKey extends string = SchemaFieldKey> =
  | SchemaDataFieldDefinition<FieldKey>
  | SchemaStructuralFieldDefinition<FieldKey>;

export type SchemaDataFieldDefinition<FieldKey extends string = SchemaFieldKey> =
  | SchemaTextField<FieldKey>
  | SchemaTextareaField<FieldKey>
  | SchemaSelectField<FieldKey>
  | SchemaRadioField<FieldKey>
  | SchemaSwitchField<FieldKey>
  | SchemaToggleField<FieldKey>
  | SchemaTagsField<FieldKey>
  | SchemaNumberField<FieldKey>
  | SchemaSliderField<FieldKey>
  | SchemaFileField<FieldKey>
  | SchemaImageUploadField<FieldKey>
  | SchemaImageSizeField<FieldKey>
  | SchemaShotListField<FieldKey>;

export type SchemaStructuralFieldDefinition<FieldKey extends string = SchemaFieldKey> =
  | SchemaGroupField<FieldKey>
  | SchemaDividerField<FieldKey>;

export interface SchemaFieldLayout {
  /**
   * 字段跨列（md+ 断点生效）。
   * 支持 1~10 列，渲染时会按当前可用列数进行夹取。
   */
  colSpan: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | undefined;
  align: "start" | "center" | "end" | "stretch" | undefined;
  sticky: boolean | undefined;
  /** Dock 呈现配置 - 控制字段在 Dock（紧凑模式）中的渲染方式 */
  dockPresentation: SchemaDockPresentation | undefined;
  /** 用于 summary 模式的模板，如 "{width}×{height}" */
  dockSummaryTemplate: string | undefined;
}

export interface SchemaFieldBase<FieldKey extends string = SchemaFieldKey> {
  key: FieldKey;
  labelKey: string | undefined;
  helperTextKey: string | undefined;
  helperTextParams: UnknownRecord | undefined;
  placeholderKey: string | undefined;
  tooltipKey: string | undefined;
  descriptionKey: string | undefined;
  layout: SchemaFieldLayout | undefined;
  visibleWhen: SchemaCondition<FieldKey> | undefined;
  disabledWhen: SchemaCondition<FieldKey> | undefined;
  required: boolean | undefined;
  requiredWhen: SchemaCondition<FieldKey> | undefined;
  validation: SchemaFieldValidation<FieldKey> | undefined;
  events: SchemaFieldEvent<FieldKey>[] | undefined;
  metadata: UnknownRecord | undefined;
  defaultValue: unknown | undefined;
  /**
   * 供调用方在“字段级”自定义样式：
   * - className/sx 将应用到该字段所在的网格容器 Box（即每个字段外层的 grid item）
   * - 如需更细粒度控制，可结合全局主题（MUI Theme）、或扩展特定字段渲染分支
   */
  className: string | undefined;
  sx: CSSProperties | UnknownRecord | undefined;
}

export interface SchemaStructuralFieldBase<FieldKey extends string = SchemaFieldKey> {
  key: FieldKey | undefined;
  labelKey: string | undefined;
  descriptionKey: string | undefined;
  layout: SchemaFieldLayout | undefined;
  visibleWhen: SchemaCondition<FieldKey> | undefined;
  /** 结构型字段同样支持字段级样式（作用于其外层网格容器） */
  className: string | undefined;
  sx: CSSProperties | UnknownRecord | undefined;
}

export interface SchemaTextField<FieldKey extends string = SchemaFieldKey> extends SchemaFieldBase<FieldKey> {
  type: "text";
  inputMode: "text" | "search" | "url" | "email" | "tel" | undefined;
  maxLength: number | undefined;
  autoComplete: string | undefined;
}

export interface SchemaTextareaField<FieldKey extends string = SchemaFieldKey>
  extends SchemaFieldBase<FieldKey> {
  type: "textarea";
  minRows: number | undefined;
  maxRows: number | undefined;
  autoResize: boolean | undefined;
  showCounter: boolean | undefined;
}

export interface SchemaSelectField<FieldKey extends string = SchemaFieldKey> extends SchemaFieldBase<FieldKey> {
  type: "select";
  options: SchemaOptionSource<FieldKey>;
  multiple: boolean | undefined;
  renderValueKey: string | undefined;
  clearable: boolean | undefined;
}

export interface SchemaRadioField<FieldKey extends string = SchemaFieldKey> extends SchemaFieldBase<FieldKey> {
  type: "radio";
  options: SchemaOptionSource<FieldKey>;
}

export interface SchemaSwitchField<FieldKey extends string = SchemaFieldKey> extends SchemaFieldBase<FieldKey> {
  type: "switch";
  trueLabelKey: string | undefined;
  falseLabelKey: string | undefined;
}

export interface SchemaToggleField<FieldKey extends string = SchemaFieldKey> extends SchemaFieldBase<FieldKey> {
  type: "toggle";
  options: SchemaOptionSource<FieldKey>;
  exclusive: boolean | undefined;
}

export interface SchemaTagsField<FieldKey extends string = SchemaFieldKey> extends SchemaFieldBase<FieldKey> {
  type: "tags";
  allowDuplicates: boolean | undefined;
  maxTags: number | undefined;
  delimiters: string[] | undefined;
}

export interface SchemaNumberField<FieldKey extends string = SchemaFieldKey> extends SchemaFieldBase<FieldKey> {
  type: "number";
  min: number | undefined;
  max: number | undefined;
  step: number | undefined;
  precision: number | undefined;
  unitKey: string | undefined;
}

export interface SchemaSliderField<FieldKey extends string = SchemaFieldKey> extends SchemaFieldBase<FieldKey> {
  type: "slider";
  min: number;
  max: number;
  step: number | undefined;
  marks: Array<{ value: number; labelKey: string | undefined }> | undefined;
}

export interface SchemaFileField<FieldKey extends string = SchemaFieldKey> extends SchemaFieldBase<FieldKey> {
  type: "file";
  accept: string | undefined;
  maxFiles: number | undefined;
  maxSizeMB: number | undefined;
  allowMultiple: boolean | undefined;
  requiredWhen: SchemaCondition<FieldKey> | undefined;
  transforms: SchemaValueTransform<FieldKey>[] | undefined;
}

export interface SchemaImageUploadField<FieldKey extends string = SchemaFieldKey>
  extends SchemaFieldBase<FieldKey> {
  type: "imageUpload";
  accept: string | undefined;
  maxFiles: number | undefined;
  /** 最大文件大小（MB），用于上传阶段拦截 */
  maxSizeMB: number | undefined;
  /** 图片最大边（像素），仅在 imageResizeMode=fit 时参与自动缩放 */
  maxDimension: number | undefined;
  /** 图片缩放策略（默认 fit） */
  imageResizeMode: ImageResizeMode | undefined;
  /** 图片维度/格式等校验约束 */
  imageConstraints: ImageValidationConstraints | undefined;
  /** 根据指定字段的值动态设置 maxFiles，优先级高于 maxFiles */
  maxFilesMap: {
    field: FieldKey;
    map: Record<string, number>;
    default: number;
  } | undefined;
  enforceImage: boolean | undefined;
  requiredWhen: SchemaCondition<FieldKey> | undefined;
  transforms: SchemaValueTransform<FieldKey>[] | undefined;
}

export interface SchemaImageSizeField<FieldKey extends string = SchemaFieldKey> extends SchemaFieldBase<FieldKey> {
  type: "imageSize";
  mode: "constrainedResolution" | undefined;
  sizeOptions: SchemaImageSizeOption[] | undefined;
  aspectField: FieldKey | undefined;
  aspectOptions: SchemaImageSizeAspectOption[] | undefined;
  allowAuto: boolean | undefined;
  sizeLevels: SchemaImageSizeLevelOption[] | undefined;
  aspectPresets: SchemaImageSizeConstrainedAspectPreset[] | undefined;
  presetOptions: SchemaImageSizePresetOption[] | undefined;
  constraints: SchemaImageSizeConstrainedResolutionConstraints | undefined;
}

export interface SchemaShotListField<FieldKey extends string = SchemaFieldKey> extends SchemaFieldBase<FieldKey> {
  type: "shotList";
  minItems: number | undefined;
  maxItems: number | undefined;
  enableReorder: boolean | undefined;
  addButtonKey: string | undefined;
  emptyStateKey: string | undefined;
  itemLabelKey: string | undefined;
  durationLabelKey: string | undefined;
  cameraMotionLabelKey: string | undefined;
  summaryLabelKey: string | undefined;
  timelineMode: "list" | "timeline" | undefined;
  defaultItem: SchemaShotListItemValue | undefined;
  presets: SchemaShotListPreset[] | undefined;
}

export interface SchemaShotListPreset {
  id: string;
  labelKey: string;
  descriptionKey: string | undefined;
  template: SchemaShotListItemValue;
}

export interface SchemaShotListItemValue {
  id: string | undefined;
  title: string | undefined;
  summary: string | undefined;
  description: string | undefined;
  beats: string[] | string | undefined;
  durationSeconds: number | undefined;
  cameraMotion: string | undefined;
  audioCue: string | undefined;
  referenceUrl: string | undefined;
  tags: string[] | undefined;
  transition: string | undefined;
  startAtSeconds: number | undefined;
  endAtSeconds: number | undefined;
  metadata: UnknownRecord | undefined;
}

export type SchemaShotListValue = SchemaShotListItemValue[];

export interface SchemaTimelineSegment {
  id: string | undefined;
  index: number;
  title: string | undefined;
  description: string | undefined;
  summary: string | undefined;
  beats: string[] | undefined;
  durationSeconds: number | undefined;
  cameraMotion: string | undefined;
  audioCue: string | undefined;
  referenceUrl: string | undefined;
  tags: string[] | undefined;
  transition: string | undefined;
  startAtSeconds: number | undefined;
  endAtSeconds: number | undefined;
  metadata: UnknownRecord | undefined;
}

export interface SchemaGroupField<FieldKey extends string = SchemaFieldKey>
  extends SchemaStructuralFieldBase<FieldKey> {
  type: "group";
  children: Array<SchemaFieldDefinition<FieldKey>>;
  collapsible: boolean | undefined;
  defaultExpanded: boolean | undefined;
}

export interface SchemaDividerField<FieldKey extends string = SchemaFieldKey>
  extends SchemaStructuralFieldBase<FieldKey> {
  type: "divider";
}

export interface SchemaFieldValidation<FieldKey extends string = SchemaFieldKey> {
  min: number | undefined;
  max: number | undefined;
  minLength: number | undefined;
  maxLength: number | undefined;
  step: number | undefined;
  pattern: string | RegExp | undefined;
  patternMessageKey: string | undefined;
  custom: SchemaValidatorFn<FieldKey> | undefined;
}

export type SchemaValidatorFn<FieldKey extends string = SchemaFieldKey> = (
  value: unknown,
  context: SchemaValidationContext<FieldKey>
) => string | null | Promise<string | null>;

export interface SchemaFieldEvent<FieldKey extends string = SchemaFieldKey> {
  kind: "change" | "blur" | "focus" | "mount" | "unmount";
  when: SchemaCondition<FieldKey> | undefined;
  handler: SchemaFieldEventHandler<FieldKey>;
}

export type SchemaFieldEventHandler<FieldKey extends string = SchemaFieldKey> = (
  value: unknown,
  context: SchemaFieldEventContext<FieldKey>
) => void | Partial<SchemaFormValues<FieldKey>> | Promise<void | Partial<SchemaFormValues<FieldKey>>>;

export interface SchemaFieldEventContext<FieldKey extends string = SchemaFieldKey> {
  field: FieldKey;
  schema: SchemaFormDefinition<FieldKey>;
  values: SchemaFormValues<FieldKey>;
  modelId: string;
  emitPrompt: (text: string) => void | undefined;
}

export interface SchemaFieldOption {
  value: unknown;
  labelKey: string;
  labelParams: UnknownRecord | undefined;
  descriptionKey: string | undefined;
  helperKey: string | undefined;
  disabledWhen: SchemaCondition | undefined;
  icon: string | undefined;
  groupKey: string | undefined;
}

export type SchemaOptionSource<FieldKey extends string = SchemaFieldKey> =
  | { kind: "static"; options: SchemaFieldOption[] }
  | { kind: "async"; loader: SchemaAsyncOptionLoader<FieldKey>; cacheKey: string | undefined; once: boolean | undefined };

export type SchemaAsyncOptionLoader<FieldKey extends string = SchemaFieldKey> = (
  context: SchemaFieldContext<FieldKey>
) => Promise<SchemaFieldOption[]>;

export interface SchemaFieldContext<FieldKey extends string = SchemaFieldKey> {
  field: FieldKey;
  schema: SchemaFormDefinition<FieldKey>;
  values: SchemaFormValues<FieldKey>;
  modelId: string;
  locale: string | undefined;
}

export type SchemaCondition<FieldKey extends string = SchemaFieldKey> =
  | SchemaConditionExpression<FieldKey>
  | SchemaConditionPredicate<FieldKey>;

export type SchemaConditionPredicate<FieldKey extends string = SchemaFieldKey> = (
  context: SchemaConditionContext<FieldKey>
) => boolean | Promise<boolean>;

export interface SchemaConditionContext<FieldKey extends string = SchemaFieldKey> {
  field: FieldKey | undefined;
  schema: SchemaFormDefinition<FieldKey>;
  values: SchemaFormValues<FieldKey>;
  modelId: string;
}

export type SchemaConditionExpression<FieldKey extends string = SchemaFieldKey> =
  | { op: "and"; conditions: SchemaCondition<FieldKey>[] }
  | { op: "or"; conditions: SchemaCondition<FieldKey>[] }
  | { op: "not"; condition: SchemaCondition<FieldKey> }
  | { op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; field: FieldKey; value: unknown }
  | { op: "includes" | "excludes"; field: FieldKey; value: unknown }
  | { op: "truthy" | "falsy"; field: FieldKey };

export interface SchemaPromptConfig<FieldKey extends string = SchemaFieldKey> {
  primaryField: FieldKey;
  summaryField: FieldKey | undefined;
  derivePrompt: (values: SchemaFormValues<FieldKey>) => string | undefined;
  applyCommand: (
    values: SchemaFormValues<FieldKey>,
    command: PromptUpdateCommand
  ) => SchemaFormValues<FieldKey> | undefined;
}

export interface SchemaPayloadDefinition<FieldKey extends string = SchemaFieldKey> {
  /**
   * 请求体格式。
   * - 静态值（json/multipart/stream）：整个模型所有请求共享同一传输格式。
   * - `"dynamic"`：表示由 `format_rule` 在请求构造期根据字段值动态决定（用于单节点承载多种
   *   远端接口语义的场景，如文生图 + 图生图合并节点）。
   * - undefined：等价于 "json"。
   */
  format: "json" | "multipart" | "stream" | "dynamic" | undefined;
  /**
   * 当 format 为 "dynamic" 时承载运行时条件求值规则。
   * 求值结果必须落入 `json | multipart | stream`。
   */
  format_rule: SchemaValueExpression<FieldKey> | undefined;
  taskType: string | undefined;
  map: SchemaPayloadMap<FieldKey>;
  hooks: SchemaPayloadHooks<FieldKey> | undefined;
}

export type SchemaPayloadMap<FieldKey extends string = SchemaFieldKey> = DynamicRecord<
  SchemaValueExpression<FieldKey>
>;

export interface SchemaPayloadHooks<FieldKey extends string = SchemaFieldKey> {
  beforeBuild: SchemaPayloadBeforeHook<FieldKey> | undefined;
  afterBuild: SchemaPayloadAfterHook<FieldKey> | undefined;
}

export type SchemaPayloadBeforeHook<FieldKey extends string = SchemaFieldKey> = (
  context: SchemaBuildContext<FieldKey>
) => void | Promise<void>;

export type SchemaPayloadAfterHook<FieldKey extends string = SchemaFieldKey> = (
  payload: SchemaGenerationPayload,
  context: SchemaBuildContext<FieldKey>
) => SchemaGenerationPayload | Promise<SchemaGenerationPayload>;

export interface SchemaBuildContext<FieldKey extends string = SchemaFieldKey> {
  schema: SchemaFormDefinition<FieldKey>;
  values: SchemaFormValues<FieldKey>;
  modelId: string;
  runtime: UnknownRecord | undefined;
}

export type SchemaValueExpression<FieldKey extends string = SchemaFieldKey> =
  | SchemaLiteralValue
  | SchemaFieldValue<FieldKey>
  | SchemaComputedValue<FieldKey>
  | SchemaConditionalValue<FieldKey>;

export interface SchemaLiteralValue {
  kind: "literal";
  value: unknown;
}

export interface SchemaFieldValue<FieldKey extends string = SchemaFieldKey> {
  kind: "field";
  field: FieldKey;
  mediaTarget: ModelAssetMediaTargetShape | undefined;
  transforms: SchemaValueTransform<FieldKey>[] | undefined;
  fallback: SchemaValueExpression<FieldKey> | undefined;
}

export interface SchemaComputedValue<FieldKey extends string = SchemaFieldKey> {
  kind: "compute";
  dependsOn: FieldKey[] | undefined;
  cacheKey: string | undefined;
  mediaTarget: ModelAssetMediaTargetShape | undefined;
  run: SchemaValueComputeHandler<FieldKey>;
}

export interface SchemaConditionalValue<FieldKey extends string = SchemaFieldKey> {
  kind: "when";
  condition: SchemaCondition<FieldKey>;
  truthy: SchemaValueExpression<FieldKey>;
  falsy: SchemaValueExpression<FieldKey> | undefined;
}

export type SchemaValueComputeHandler<FieldKey extends string = SchemaFieldKey> = (
  context: SchemaBuildContext<FieldKey>
) => unknown | Promise<unknown>;

export type SchemaValueTransform<FieldKey extends string = SchemaFieldKey> =
  | SchemaBuiltinTransform
  | SchemaValueTransformFactory<FieldKey>;

export type SchemaBuiltinTransform =
  | "trim"
  | "toLowerCase"
  | "toUpperCase"
  | "toNumber"
  | "ensureArray"
  | "first"
  | "splitLines"
  | "compactArray"
  | "last"
  | "shotListToTimeline"
  | "timelineToScript";

export type SchemaValueTransformFactory<FieldKey extends string = SchemaFieldKey> = (
  value: unknown,
  context: SchemaTransformContext<FieldKey>
) => unknown | Promise<unknown>;

export interface SchemaTransformContext<FieldKey extends string = SchemaFieldKey> {
  field: FieldKey | undefined;
  targetPath: string | undefined;
  mediaTarget: ModelAssetMediaTargetShape | undefined;
  values: SchemaFormValues<FieldKey>;
  schema: SchemaFormDefinition<FieldKey>;
  modelId: string;
  runtime: UnknownRecord | undefined;
}

export { literal, fromField, when, compute } from "./valueExpressionFactories";
