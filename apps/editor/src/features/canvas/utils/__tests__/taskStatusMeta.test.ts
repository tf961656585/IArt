import { describe, expect, it } from 'vitest';

import { getTaskStatusLabel, getTaskStatusOverlayText } from '../taskStatusMeta';

/**
 * status + phase -> 状态文案映射（taskStatusMeta.ts）。
 */
describe('resolveTaskStatusMeta', () => {
  it('submitting + uploading_input -> 上传图像中（既有映射零回归）', () => {
    expect(getTaskStatusLabel('submitting', 'uploading_input')).toBe('上传图像中');
    expect(getTaskStatusOverlayText('submitting', 'uploading_input')).toBe('上传图像中...');
  });

  it('submitting 无 phase -> 提交中（缺省流转零回归）', () => {
    expect(getTaskStatusLabel('submitting', null)).toBe('提交中');
    expect(getTaskStatusLabel('submitting', 'requesting')).toBe('提交中');
  });

  it('非 submitting 状态不受 phase 影响', () => {
    expect(getTaskStatusLabel('generating', 'uploading_input')).toBe('生成中');
    expect(getTaskStatusLabel('failed', 'uploading_input')).toBe('失败');
  });
});
