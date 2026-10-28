/**
 * 扩图提交前置校验（spec：docs/editor/节点执行前置校验.md，媒体工具执行同口径）。
 *
 * 单一实现：统一媒体工具执行器（`components/chrome/mediaToolExecutors` 的
 * `runOutpaint`）调用本模块；资产节点与导入素材节点共用同一入口，
 * 禁止各入口各写一份（spec 媒体工具加工.md「禁止同一工具不同入口行为分叉」）。
 *
 * 校验项：
 * - ② 引用资产不可用：源图为空（弹窗 confirm 时现取，取不到即内容为空/已被移除）
 * - ③ 必需参数缺失或非法：扩图模型必选且可用、prompt 超 schema 上限
 *
 * 无副作用——不读写 canvas store、不创建任务记录。
 */

import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from '@iart/contracts';

import { resolveRuntimeProjectedImageToImageModel } from '@/client/config/runtimeModelSelection';
import type { ImageOutpaintDialogConfirmPayload } from '../components/dialogs/imageOutpaintDialogTypes';
import type { ExecutionPreflightIssue } from '../types/executionPreflight';
import { buildOutpaintPrompt } from './imageOutpaint';
import {
  checkPromptLength,
  formatPromptLengthError,
  PromptLengthExceededError,
} from '../nodes/textInput/promptLengthLimit';

/**
 * 扩图提交前校验：聚合全部问题，任一不通过即拦截。
 * 无副作用——不读写 canvas store、不创建任务记录。
 */
export const validateImageOutpaintPreflight = async (
  nodeId: string,
  payload: ImageOutpaintDialogConfirmPayload,
): Promise<ExecutionPreflightIssue[]> => {
  const issues: ExecutionPreflightIssue[] = [];

  // ② 引用资产不可用：源图在弹窗 confirm 时现取，取不到即内容为空/已被移除
  if (!payload.sourceImage) {
    issues.push({
      kind: 'upstream-asset-unavailable',
      nodeId,
      reason: 'empty-material-node',
      message: '当前图片内容为空或已被移除，请重新上传后再扩图。',
    });
  }

  // ③ 必需参数缺失或非法：扩图模型必选且可用
  const modelId = payload.modelId.trim();
  if (!modelId) {
    issues.push({
      kind: 'invalid-required-parameter',
      nodeId,
      fieldKey: 'modelId',
      message: '还没有选择扩图模型，请先选择。',
    });
    return issues;
  }
  const config = resolveRuntimeProjectedImageToImageModel(modelId);
  if (!config) {
    issues.push({
      kind: 'invalid-required-parameter',
      nodeId,
      fieldKey: 'modelId',
      message: `扩图模型「${modelId}」不可用，请重新选择。`,
    });
    return issues;
  }

  // ③ schema 层面非法值：实际提交的 prompt（预设 + 用户补充）不得超过模型上限。
  // 上限单一事实源是投影顶层 prompt_field.validation_rules 的 max_length（方案 B），
  // 经 assetInputContract.promptMaxLength 暴露；不再从 parameter_schema.fields 读 schema 字段。
  const promptMaxLength =
    config.assetInputContract !== null && config.assetInputContract !== undefined
      ? config.assetInputContract.promptMaxLength
      : undefined;
  const lengthCheck = checkPromptLength({
    prompt: buildOutpaintPrompt(payload.userPrompt),
    limit: promptMaxLength,
  });
  if (!lengthCheck.ok && lengthCheck.limit !== undefined) {
    issues.push({
      kind: 'invalid-required-parameter',
      nodeId,
      fieldKey: MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY,
      message: formatPromptLengthError(
        new PromptLengthExceededError({
          modelId: config.modelId ?? modelId,
          actual: lengthCheck.actual,
          limit: lengthCheck.limit,
          fieldKey: MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY,
        }),
      ),
    });
  }

  return issues;
};

/** 校验问题的 toast 摘要（详情以节点级诊断为准，toast 只给一句可读结论）。 */
export const formatOutpaintPreflightSummary = (issues: ExecutionPreflightIssue[]): string => {
  if (issues.length === 0) return '';
  const first = issues[0];
  const firstMessage = first?.message ?? '';
  if (issues.length === 1) return `无法开始扩图：${firstMessage}`;
  return `有 ${issues.length} 处需要先处理：${firstMessage} 等`;
};
