import type { ComponentType, ReactNode } from "react";
import type { UploadFileItem } from "@/client/components/FileUpload";
import type { SchemaGenerationPayload } from "@/client/types/generation";
import type { NormalizedOutput } from "@/client/utils/outputNormalize";
import type { SchemaFieldKey, SchemaFormDefinition } from "./schema/types";
import type { ImageResizeMode, ImageValidationConstraints } from '@iart/contracts/media/imageValidationTypes';

type BivariantHandler<TArgs extends unknown[], TResult> = {
  bivarianceHack: (...args: TArgs) => TResult;
}["bivarianceHack"];

export type ModelWorkspaceTaskListPosition = "left" | "right" | "bottom";

export interface ModelWorkspaceTaskListConfig {
  position: ModelWorkspaceTaskListPosition | undefined;
}

export type InlineControlKind = 'select' | 'toggle' | 'number' | 'switch' | 'aspect';

export interface InlineControlItem {
  field: string;
  kind: InlineControlKind;
  width: 'auto' | 'sm' | 'md' | undefined;
}

export interface PromptDockConfig {
  mediaSlots: PromptDockMediaSlotDescriptor[] | undefined;
  /**
   * 在 Dock（紧凑模式）中内联展示的表单字段清单（紧凑样式）
   * - 低侵入：仅控制 Dock 行内 UI 呈现，不改动 Schema
   */
  inlineControls: InlineControlItem[] | undefined;
  /**
   * 生成方案/模式字段（例如 'mode' | 'canvas' | 'preset'）
   * - 用于与“当前模型选择”同行展示
   */
  planField: string | undefined;
}

export interface ModelOutputComponentProps {
  modelId: string;
  output: NormalizedOutput | null | undefined;
  error: string | null | undefined;
  busy: boolean | undefined;
  messages: string[] | undefined;
}

export interface ModelFormProps<FormValues> {
  modelId: string;
  values: FormValues;
  onChange: BivariantHandler<[FormValues], void>;
  onSubmit: BivariantHandler<[FormValues], void | Promise<void>>;
  busy: boolean;
  error: string | null | undefined;
  messages: string[] | undefined;
  taskListSlot: ReactNode | undefined;
  onPromptChange: (prompt: string) => void | undefined;
}

export interface ModelFormSubmitContext<FormValues> {
  modelId: string;
  values: FormValues;
}

export type PromptCommandMode = "replace" | "append";

export interface PromptUpdateCommand {
  id: string;
  text: string;
  mode: PromptCommandMode;
}

export type PromptDockMediaSlotMode = "single" | "multiple";

export interface PromptDockMediaSlotDescriptor {
  id: string;
  targetField: string;
  labelKey: string | undefined;
  label: string | undefined;
  helperTextKey: string | undefined;
  helperText: string | undefined;
  accept: string[] | undefined;
  minFiles: number | undefined;
  maxFiles: number | undefined;
  mode: PromptDockMediaSlotMode | undefined;
  required: boolean | undefined;
  /** 最大文件大小（MB），用于在上传阶段拦截不合规文件 */
  maxSizeMB: number | undefined;
  /** 图片维度/格式等校验约束（仅对 image 生效） */
  imageConstraints: ImageValidationConstraints | undefined;
  /** 图片缩放策略（默认 fit；Wan 等严格模型建议使用 none） */
  imageResizeMode: ImageResizeMode | undefined;
}

export type PromptDockMediaValueMap = Record<string, UploadFileItem[]>;

export interface CustomFormConfig<FormValues = unknown> {
  kind: "custom";
  load: () => Promise<{ default: ComponentType<ModelFormProps<FormValues>> }>;
  createInitialValues: () => FormValues;
  buildPayload: BivariantHandler<
    [FormValues, ModelFormSubmitContext<FormValues>],
    Promise<SchemaGenerationPayload> | SchemaGenerationPayload
  >;
  getPrompt: (values: FormValues) => string | undefined | undefined;
  applyPrompt: (values: FormValues, command: PromptUpdateCommand) => FormValues | undefined;
}

export interface SchemaFormConfig<FieldKey extends string = SchemaFieldKey> {
  kind: "schema";
  load: () => Promise<
    | SchemaFormDefinition<FieldKey>
    | { default: SchemaFormDefinition<FieldKey> }
    | { schema: SchemaFormDefinition<FieldKey> }
  >;
}

export type ModelWorkspaceFormConfig<FormValues = unknown> =
  | CustomFormConfig<FormValues>
  | SchemaFormConfig
  | undefined;

export const isCustomFormConfig = <FormValues,>(
  config: ModelWorkspaceFormConfig<FormValues> | undefined
): config is CustomFormConfig<FormValues> => (config !== null && config !== undefined ? config.kind : undefined) === "custom";

export const isSchemaFormConfig = (
  config: ModelWorkspaceFormConfig | undefined
): config is SchemaFormConfig => (config !== null && config !== undefined ? config.kind : undefined) === "schema";

export interface DefaultOutputConfig {
  kind: "default" | undefined;
}

export interface CustomOutputConfig {
  kind: "custom";
  load: () => Promise<{ default: ComponentType<ModelOutputComponentProps> }>;
}

export type ModelWorkspaceOutputConfig = DefaultOutputConfig | CustomOutputConfig;

export const isCustomOutputConfig = (
  config: ModelWorkspaceOutputConfig | undefined
): config is CustomOutputConfig => (config !== null && config !== undefined ? config.kind : undefined) === "custom";

export interface ModelWorkspaceTaskQueueConfig {
  enabled: boolean;
  maxConcurrent: number | undefined;
}

export interface ModelResultExtractor {
  /** 视频URL提取路径数组，按优先级排序 */
  videoPaths: string[] | undefined;
  /** 图片URL提取路径数组 */
  imagePaths: string[] | undefined;
  /** 文本结果提取路径数组 */
  textPaths: string[] | undefined;
  /** 需要排除的字段路径，避免抓取输入资源 */
  excludePaths: string[] | undefined;
}

export interface ModelWorkspaceConfig<FormValues = unknown> {
  form: ModelWorkspaceFormConfig<FormValues> | undefined;
  taskList: ModelWorkspaceTaskListConfig | undefined;
  output: ModelWorkspaceOutputConfig | undefined;
  dock: PromptDockConfig | undefined;
  taskQueue: ModelWorkspaceTaskQueueConfig | undefined;
  resultExtractor: ModelResultExtractor | undefined;
}
