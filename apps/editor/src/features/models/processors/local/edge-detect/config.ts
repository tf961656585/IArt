import type { PromptDockMediaSlotDescriptor, SchemaFormConfig } from '@/features/workspace/modelFormTypes';
import type { SchemaFormDefinition } from '@/features/workspace/schema/types';

export const edgeDetectFormConfig: SchemaFormConfig = {
  kind: 'schema',
  load: () =>
    import('./schema').then(
      (mod) => (mod.edgeDetectFormSchema as SchemaFormDefinition<string>) ?? (mod.default as SchemaFormDefinition<string>)
    ),
};

export const edgeDetectDockSlots: PromptDockMediaSlotDescriptor[] = [
  {
    id: 'images',
    targetField: 'images',
    labelKey: undefined,
    label: '输入图片',
    helperTextKey: undefined,
    helperText: '选择待检测边缘的图片（最多 1 张）',
    accept: ['image/*'],
    minFiles: undefined,
    maxFiles: 1,
    mode: 'single',
    required: true,
    maxSizeMB: undefined,
    imageConstraints: undefined,
    imageResizeMode: undefined,
  },
];
