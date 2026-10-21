import type { ExecutableCatalogMediaSlot, ExecutableModelDirectoryEntry } from '@iart/contracts';

/**
 * 可执行模型目录条目的测试工厂（PromptDock 域共享）。
 *
 * 为什么要有它：0.6.5 的参考区用途预检依赖「目录条目带 `media_slots`」这一契约，而各测试
 * 文件原本各自手写一份**不带 media_slots** 的退化条目，导致新增的用途判据在真实运行时生效、
 * 在测试里恒不生效（`collectSlotProblems` 见到空清单直接返回）。fixture 比契约窄会让任何新增
 * 前置校验失去回归保护——本工厂把「目录条目的形状」收敛到一处，素材位按参数显式给。
 *
 * 默认档（不传 `mediaSlots`）对应**纯文生图/文生视频族**：没有媒体上传字段，参考区不呈现
 * 用途徽章、用途判据不触发。需要覆盖用途链路的用例必须显式传 `mediaSlots`。
 */

/** 图像编辑形态：一个可放多张的参考位（gpt-image 一代的形状）。 */
export const multiImageRefSlots: ExecutableCatalogMediaSlot[] = [
  {
    slotId: 'reference_image',
    fieldKey: 'image',
    required: false,
    maxFiles: 16,
    mediaKind: 'image',
    label: 'image',
  },
];

/** 图生视频形态：首帧必填 + 尾帧可选，都是单张位（可灵图生视频的形状）。 */
export const firstLastFrameSlots: ExecutableCatalogMediaSlot[] = [
  {
    slotId: 'first_frame',
    fieldKey: 'firstFrameImage',
    required: true,
    maxFiles: 1,
    mediaKind: 'image',
    label: '首帧',
  },
  {
    slotId: 'last_frame',
    fieldKey: 'lastFrameImage',
    required: false,
    maxFiles: 1,
    mediaKind: 'image',
    label: '尾帧',
  },
];

/** 单张位与多张位并存（首帧可选 + 普通参考多张位）。 */
export const mixedFirstFrameAndMultiSlots: ExecutableCatalogMediaSlot[] = [
  {
    slotId: 'first_frame',
    fieldKey: 'firstFrameImage',
    required: false,
    maxFiles: 1,
    mediaKind: 'image',
    label: '首帧',
  },
  {
    slotId: 'reference_image',
    fieldKey: 'images',
    required: false,
    maxFiles: 8,
    mediaKind: 'image',
    label: '普通参考',
  },
];

export const createCatalogEntry = (
  overrides: Partial<ExecutableModelDirectoryEntry> = {},
): ExecutableModelDirectoryEntry => ({
  model_id: 'model-a',
  model_version: '1.0.0',
  default_task_type: 'image',
  capability: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
  parameter_schema: { fields: [], required_fields: [], default_values: {} },
  deployment: {
    has_active_deployment: true,
    active_deployment_id: 'dep_1',
    deployable: true,
    failure_code: 'none',
  },
  ...overrides,
});

/** 带媒体素材位的目录条目：用途判据生效的形态。 */
export const createCatalogEntryWithSlots = (
  mediaSlots: ExecutableCatalogMediaSlot[],
  overrides: Partial<ExecutableModelDirectoryEntry> = {},
): ExecutableModelDirectoryEntry =>
  createCatalogEntry({
    ...overrides,
    media_slots: mediaSlots,
  });
