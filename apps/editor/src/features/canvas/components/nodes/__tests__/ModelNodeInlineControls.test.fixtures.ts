import type { ModelConfigEntry } from '@/client/config/models.config';
import type { GraphNode, ModelNodeData } from '@/features/canvas/types';
import { createDefaultResultAreaEmbeddedData } from '@/features/canvas/services/resultAreaEmbeddedFactory';
import type { SchemaFormDefinition } from '@/features/workspace/schema/types';

const BASE_TEST_MODEL_CONFIG: Pick<
  ModelConfigEntry,
  | 'defaults'
  | 'visible'
  | 'role'
  | 'description'
  | 'aliases'
  | 'routeSegment'
  | 'canvasPortSpec'
  | 'i18n'
  | 'nodeGraphPorts'
  | 'videoGenMode'
  | 'capabilities'
  | 'assetCapabilities'
  | 'assetInputContract'
  | 'variantGroup'
> = {
  defaults: undefined,
  visible: undefined,
  role: undefined,
  description: undefined,
  aliases: undefined,
  routeSegment: undefined,
  canvasPortSpec: undefined,
  i18n: undefined,
  nodeGraphPorts: undefined,
  videoGenMode: undefined,
  capabilities: undefined,
  assetCapabilities: undefined,
  assetInputContract: undefined,
  variantGroup: undefined,
};

export const INLINE_TEST_SCHEMA: SchemaFormDefinition<string> = {
  meta: {
    id: 'inline-test',
    version: '1',
    modelId: 'inline-test-model',
    titleKey: undefined,
    descriptionKey: undefined,
    docLinkKey: undefined,
  },
  fields: [
    { key: 'obscureAlpha', type: 'switch', labelKey: 'obscureAlpha', defaultValue: false, trueLabelKey: undefined, falseLabelKey: undefined, helperTextKey: undefined, helperTextParams: undefined, placeholderKey: undefined, tooltipKey: undefined, descriptionKey: undefined, layout: undefined, visibleWhen: undefined, disabledWhen: undefined, required: undefined, requiredWhen: undefined, validation: undefined, events: undefined, metadata: undefined, className: undefined, sx: undefined },
    { key: 'obscureBeta', type: 'select', labelKey: 'obscureBeta', defaultValue: 'off', options: { kind: 'static', options: [ { value: 'off', labelKey: 'off', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined }, { value: 'on', labelKey: 'on', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined } ] }, multiple: undefined, renderValueKey: undefined, clearable: undefined, helperTextKey: undefined, helperTextParams: undefined, placeholderKey: undefined, tooltipKey: undefined, descriptionKey: undefined, layout: undefined, visibleWhen: undefined, disabledWhen: undefined, required: undefined, requiredWhen: undefined, validation: undefined, events: undefined, metadata: undefined, className: undefined, sx: undefined },
    { key: 'imageSize', type: 'imageSize', labelKey: 'imageSize', defaultValue: '1024x1024', mode: undefined, sizeOptions: undefined, aspectField: undefined, aspectOptions: undefined, allowAuto: undefined, sizeLevels: undefined, aspectPresets: undefined, presetOptions: undefined, constraints: undefined, helperTextKey: undefined, helperTextParams: undefined, placeholderKey: undefined, tooltipKey: undefined, descriptionKey: undefined, layout: undefined, visibleWhen: undefined, disabledWhen: undefined, required: undefined, requiredWhen: undefined, validation: undefined, events: undefined, metadata: undefined, className: undefined, sx: undefined },
    { key: 'duration', type: 'number', labelKey: 'duration', defaultValue: 5, min: undefined, max: undefined, step: undefined, precision: undefined, unitKey: undefined, helperTextKey: undefined, helperTextParams: undefined, placeholderKey: undefined, tooltipKey: undefined, descriptionKey: undefined, layout: undefined, visibleWhen: undefined, disabledWhen: undefined, required: undefined, requiredWhen: undefined, validation: undefined, events: undefined, metadata: undefined, className: undefined, sx: undefined },
    { key: 'seed', type: 'text', labelKey: 'seed', defaultValue: '42', inputMode: undefined, maxLength: undefined, autoComplete: undefined, helperTextKey: undefined, helperTextParams: undefined, placeholderKey: undefined, tooltipKey: undefined, descriptionKey: undefined, layout: undefined, visibleWhen: undefined, disabledWhen: undefined, required: undefined, requiredWhen: undefined, validation: undefined, events: undefined, metadata: undefined, className: undefined, sx: undefined },
    { key: 'watermark', type: 'switch', labelKey: 'watermark', defaultValue: true, trueLabelKey: undefined, falseLabelKey: undefined, helperTextKey: undefined, helperTextParams: undefined, placeholderKey: undefined, tooltipKey: undefined, descriptionKey: undefined, layout: undefined, visibleWhen: undefined, disabledWhen: undefined, required: undefined, requiredWhen: undefined, validation: undefined, events: undefined, metadata: undefined, className: undefined, sx: undefined },
    { key: 'private', type: 'switch', labelKey: 'private', defaultValue: false, trueLabelKey: undefined, falseLabelKey: undefined, helperTextKey: undefined, helperTextParams: undefined, placeholderKey: undefined, tooltipKey: undefined, descriptionKey: undefined, layout: undefined, visibleWhen: undefined, disabledWhen: undefined, required: undefined, requiredWhen: undefined, validation: undefined, events: undefined, metadata: undefined, className: undefined, sx: undefined },
    { key: 'steps', type: 'number', labelKey: 'steps', defaultValue: 28, min: undefined, max: undefined, step: undefined, precision: undefined, unitKey: undefined, helperTextKey: undefined, helperTextParams: undefined, placeholderKey: undefined, tooltipKey: undefined, descriptionKey: undefined, layout: undefined, visibleWhen: undefined, disabledWhen: undefined, required: undefined, requiredWhen: undefined, validation: undefined, events: undefined, metadata: undefined, className: undefined, sx: undefined },
    { key: 'quality', type: 'select', labelKey: 'quality', defaultValue: 'standard', options: { kind: 'static', options: [ { value: 'standard', labelKey: 'standard', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined }, { value: 'high', labelKey: 'high', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined } ] }, multiple: undefined, renderValueKey: undefined, clearable: undefined, helperTextKey: undefined, helperTextParams: undefined, placeholderKey: undefined, tooltipKey: undefined, descriptionKey: undefined, layout: undefined, visibleWhen: undefined, disabledWhen: undefined, required: undefined, requiredWhen: undefined, validation: undefined, events: undefined, metadata: undefined, className: undefined, sx: undefined },
    { key: 'scheduler', type: 'select', labelKey: 'scheduler', defaultValue: 'fast', options: { kind: 'static', options: [ { value: 'fast', labelKey: 'fast', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined }, { value: 'quality', labelKey: 'quality-mode', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined } ] }, multiple: undefined, renderValueKey: undefined, clearable: undefined, helperTextKey: undefined, helperTextParams: undefined, placeholderKey: undefined, tooltipKey: undefined, descriptionKey: undefined, layout: undefined, visibleWhen: undefined, disabledWhen: undefined, required: undefined, requiredWhen: undefined, validation: undefined, events: undefined, metadata: undefined, className: undefined, sx: undefined },
    { key: 'style', type: 'select', labelKey: 'style', defaultValue: 'cinematic', options: { kind: 'static', options: [ { value: 'cinematic', labelKey: 'cinematic', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined }, { value: 'anime', labelKey: 'anime', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined } ] }, multiple: undefined, renderValueKey: undefined, clearable: undefined, helperTextKey: undefined, helperTextParams: undefined, placeholderKey: undefined, tooltipKey: undefined, descriptionKey: undefined, layout: undefined, visibleWhen: undefined, disabledWhen: undefined, required: undefined, requiredWhen: undefined, validation: undefined, events: undefined, metadata: undefined, className: undefined, sx: undefined },
  ],
  layout: {
    sections: [
      { id: 'advanced-output', titleKey: '输出与隐私', descriptionKey: undefined, fields: ['watermark', 'private'], visibleWhen: undefined, columns: undefined },
      { id: 'advanced-quality', titleKey: '质量采样', descriptionKey: undefined, fields: ['steps', 'quality', 'scheduler'], visibleWhen: undefined, columns: undefined },
      { id: 'advanced-style', titleKey: '风格细化', descriptionKey: undefined, fields: ['style'], visibleWhen: undefined, columns: undefined },
    ],
    stickyFooter: undefined,
    columns: undefined,
  },
  defaults: undefined,
  formValidators: undefined,
  prompt: undefined,
  payload: { format: undefined, format_rule: undefined, taskType: undefined, map: {}, hooks: undefined },
  responseHandling: undefined,
};

export const buildInlineTestConfig = (): ModelConfigEntry => ({
  providerId: 'openai',
  label: 'Inline Test Model',
  modelId: 'inline-test-model',
  groupId: undefined,
  defaultTaskType: 'image',
  mode: 'image',
  adapter: {} as ModelConfigEntry['adapter'],
  ...BASE_TEST_MODEL_CONFIG,
  workspace: { form: { kind: 'schema', load: async () => INLINE_TEST_SCHEMA }, taskList: undefined, output: undefined, dock: { mediaSlots: undefined, inlineControls: [ { field: 'imageSize', kind: 'aspect', width: 'md' }, { field: 'duration', kind: 'number', width: 'sm' }, { field: 'seed', kind: 'select', width: 'sm' } ], planField: undefined }, taskQueue: undefined, resultExtractor: undefined },
  canvasInspector: { properties: ['watermark', 'private', 'steps', 'quality', 'scheduler', 'style', 'obscureAlpha', 'obscureBeta'] },
});

export const buildInlineTestNode = (overrides: Partial<ModelNodeData> | undefined): GraphNode<ModelNodeData> => ({
  id: 'node-inline-test',
  type: 'model',
  position: { x: 0, y: 0 },
  data: { label: 'Inline Test Model', shellModelId: undefined, modelId: 'inline-test-model', formValues: { obscureAlpha: false, obscureBeta: 'off', imageSize: '1024x1024', duration: 5, seed: '42', watermark: true, private: false, steps: 28, quality: 'standard', scheduler: 'fast', style: 'cinematic' }, portMapping: {}, inlineControlsCollapsed: false, inlineAdvancedGroupsExpanded: {}, lastExecutionId: undefined, taskInfo: undefined, executionPreferences: undefined, promptPresetSnapshots: undefined, resultArea: createDefaultResultAreaEmbeddedData(), description: undefined, runtimeRef: undefined, ...(overrides ?? {}) },
  draggable: undefined,
  size: undefined,
  style: undefined,
  groupId: undefined,
});

export const buildClearableSelectSchema = (): SchemaFormDefinition<string> => ({
  meta: { id: 'clearable-select-test', version: '1', modelId: 'clearable-select-model', titleKey: undefined, descriptionKey: undefined, docLinkKey: undefined },
  fields: [
    { key: 'size', type: 'select', labelKey: '画面尺寸', clearable: true, options: { kind: 'static', options: [ { value: '1024x1024', labelKey: '方形 1024x1024', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined }, { value: '1536x1024', labelKey: '横屏 1536x1024', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined }, { value: '1024x1536', labelKey: '竖屏 1024x1536', labelParams: undefined, descriptionKey: undefined, helperKey: undefined, disabledWhen: undefined, icon: undefined, groupKey: undefined } ] }, multiple: undefined, renderValueKey: undefined, defaultValue: undefined, helperTextKey: undefined, helperTextParams: undefined, placeholderKey: undefined, tooltipKey: undefined, descriptionKey: undefined, layout: undefined, visibleWhen: undefined, disabledWhen: undefined, required: undefined, requiredWhen: undefined, validation: undefined, events: undefined, metadata: undefined, className: undefined, sx: undefined },
  ],
  layout: undefined,
  defaults: undefined,
  formValidators: undefined,
  prompt: undefined,
  payload: { format: undefined, format_rule: undefined, taskType: undefined, map: {}, hooks: undefined },
  responseHandling: undefined,
});

export const buildClearableSelectConfig = (schema: SchemaFormDefinition<string>): ModelConfigEntry => ({
  providerId: 'openai',
  label: 'Clearable Select Model',
  modelId: 'clearable-select-model',
  groupId: undefined,
  defaultTaskType: 'image',
  mode: 'image',
  adapter: {} as ModelConfigEntry['adapter'],
  ...BASE_TEST_MODEL_CONFIG,
  workspace: { form: { kind: 'schema', load: async () => schema }, taskList: undefined, output: undefined, dock: { mediaSlots: undefined, inlineControls: [{ field: 'size', kind: 'select', width: 'md' }], planField: undefined }, taskQueue: undefined, resultExtractor: undefined },
  canvasInspector: { properties: ['size'] },
});
