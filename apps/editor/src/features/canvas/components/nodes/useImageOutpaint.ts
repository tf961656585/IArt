/**
 * imageInput 扩图（outpaint）逻辑 hook。
 *
 * 扩图结果直接落到 imageInput 自身（imageUrl/taskInfo/runtimeRef），
 * 不再创建独立 resultArea 节点。imageInput 是异步生命周期节点，
 * IPC task index 同步通过 runtimeRef.taskId 匹配并回写结果。
 *
 * 提交前执行统一前置校验（spec：docs/editor/节点执行前置校验.md，
 * 媒体工具执行同口径）：源图不可用（校验项②）、扩图模型缺失/不可用、
 * prompt 超 schema 上限（校验项③）时不创建任务记录、不发起远端请求；
 * 反馈走 executionStore 节点级诊断通道，toast 仅作摘要。
 */

import { useCallback } from "react";
import { toast } from "sonner";
import type { ImageOutpaintDialogConfirmPayload } from "../dialogs/ImageOutpaintDialog";
import type { ImageInputNodeData } from "../../types";
import type { ExecutionPreflightIssue } from "../../types/executionPreflight";
import { useCanvasStore } from "../../store/canvasStore";
import { useExecutionStore } from "../../store/executionStore";
import { buildOutpaintPrompt, outpaintImageWithModel } from "../../services/imageOutpaint";
import { resolveRuntimeProjectedImageToImageModel } from "@/client/config/runtimeModelSelection";
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from "@iart/contracts";
import {
  checkPromptLength,
  formatPromptLengthError,
  PromptLengthExceededError,
} from "../../nodes/textInput/promptLengthLimit";
import type { DynamicRecord } from "@/client/utils/typeGuards";
import { createOutpaintTaskInfo, bindOutpaintTaskInfo } from "./imageOutpaintTaskSubmission";

const generateClientTaskRef = (): string => {
  try {
    return `outpaint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  } catch {
    return `outpaint_${Date.now()}`;
  }
};

const readCurrentTaskInfo = (id: string): ImageInputNodeData["taskInfo"] => {
  const snapshot = useCanvasStore.getState().nodeGraph;
  const node = snapshot !== null && snapshot !== undefined ? snapshot.nodes.find((n) => n.id === id) : undefined;
  return node !== undefined ? (node.data as ImageInputNodeData).taskInfo : undefined;
};

/**
 * 扩图提交前校验：聚合全部问题，任一不通过即拦截。
 * 无副作用——不读写 canvas store、不创建任务记录。
 */
const validateImageOutpaintPreflight = async (
  nodeId: string,
  payload: ImageOutpaintDialogConfirmPayload,
): Promise<ExecutionPreflightIssue[]> => {
  const issues: ExecutionPreflightIssue[] = [];

  // ② 引用资产不可用：源图在弹窗 confirm 时现取，取不到即内容为空/已被移除
  if (!payload.sourceImage) {
    issues.push({
      kind: "upstream-asset-unavailable",
      nodeId,
      reason: "empty-material-node",
      message: "当前图片内容为空或已被移除，请重新上传后再扩图。",
    });
  }

  // ③ 必需参数缺失或非法：扩图模型必选且可用
  const modelId = payload.modelId.trim();
  if (!modelId) {
    issues.push({
      kind: "invalid-required-parameter",
      nodeId,
      fieldKey: "modelId",
      message: "还没有选择扩图模型，请先选择。",
    });
    return issues;
  }
  const config = resolveRuntimeProjectedImageToImageModel(modelId);
  if (!config) {
    issues.push({
      kind: "invalid-required-parameter",
      nodeId,
      fieldKey: "modelId",
      message: `扩图模型「${modelId}」不可用，请重新选择。`,
    });
    return issues;
  }

  // ③ schema 层面非法值：实际提交的 prompt（预设 + 用户补充）不得超过模型上限。
  // 上限单一事实源是投影顶层 prompt_field.validation_rules 的 max_length（方案 B），
  // 经 assetInputContract.promptMaxLength 暴露；不再从 parameter_schema.fields 读 schema 字段。
  const promptMaxLength = config.assetInputContract !== null && config.assetInputContract !== undefined
    ? config.assetInputContract.promptMaxLength
    : undefined;
  const lengthCheck = checkPromptLength({
    prompt: buildOutpaintPrompt(payload.userPrompt),
    limit: promptMaxLength,
  });
  if (!lengthCheck.ok && lengthCheck.limit !== undefined) {
    issues.push({
      kind: "invalid-required-parameter",
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

export const useImageOutpaint = (
  id: string,
  nodeGraphId: string | undefined,
  updateNodeData: (nodeId: string, data: DynamicRecord, via: string | undefined) => void,
) => {
  return useCallback((payload: ImageOutpaintDialogConfirmPayload) => {
    void (async () => {
      // 统一前置校验：任一不通过即拦截——不写 taskInfo、不发起远端请求
      const issues = await validateImageOutpaintPreflight(id, payload);
      useExecutionStore.getState().setPreflightIssues(issues);
      if (issues.length > 0) {
        toast.error(formatPreflightIssuesSummary(issues));
        return;
      }
      const modelId = payload.modelId.trim();

      updateNodeData(id, { outpaintModelId: modelId }, undefined);
      const now = Date.now();
      const initialTaskInfo = createOutpaintTaskInfo({ taskIndex: 0, modelId, now });
      updateNodeData(id, { taskInfo: initialTaskInfo, valueSource: "processed" }, undefined);
      toast.success("已开始扩图，结果将更新到当前图片");

      try {
        const result = await outpaintImageWithModel({
          modelId,
          sourceImage: payload.sourceImage,
          aspectRatio: payload.aspectRatio,
          imageSize: payload.imageSize,
          userPrompt: payload.userPrompt,
          taskBinding: { clientTaskRef: generateClientTaskRef(), taskIndex: 0, targetNodeId: id, nodeGraphId, sourceNodeId: id },
          onTaskAccepted: (taskId: string) => {
            const acceptedNow = Date.now();
            const nextTaskInfo = bindOutpaintTaskInfo({ existingTaskInfo: readCurrentTaskInfo(id), modelId, createdAtFallback: now, patch: { taskId, status: "submitting", updatedAt: acceptedNow }, now: acceptedNow });
            useCanvasStore.getState().updateNodeData(id, { taskInfo: nextTaskInfo, runtimeRef: { taskId, resultId: undefined, assetId: null } }, undefined);
          },
        });

        if (result.kind === "backend-task-pending") {
          const pendingNow = Date.now();
          const nextTaskInfo = bindOutpaintTaskInfo({ existingTaskInfo: readCurrentTaskInfo(id), modelId, createdAtFallback: now, patch: { taskId: result.taskId ?? undefined, status: result.taskId ? "submitting" : undefined }, now: pendingNow });
          useCanvasStore.getState().updateNodeData(id, { taskInfo: nextTaskInfo, runtimeRef: result.taskId ? { taskId: result.taskId, resultId: undefined, assetId: null } : undefined }, undefined);
          return;
        }

        // kind === "completed": 扩图结果直接落 imageInput 自身
        const completedNow = Date.now();
        const completedTaskInfo = bindOutpaintTaskInfo({ existingTaskInfo: readCurrentTaskInfo(id), modelId, createdAtFallback: now, patch: { status: "succeeded" }, now: completedNow });
        useCanvasStore.getState().updateNodeData(id, { imageUrl: result.url, valueSource: "processed", taskInfo: completedTaskInfo }, undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorNow = Date.now();
        const errorTaskInfo = bindOutpaintTaskInfo({ existingTaskInfo: readCurrentTaskInfo(id), modelId, createdAtFallback: now, patch: { status: "failed", error: message || "扩图失败" }, now: errorNow });
        useCanvasStore.getState().updateNodeData(id, { taskInfo: errorTaskInfo }, undefined);
        toast.error(message || "扩图失败");
      }
    })();
  }, [id, nodeGraphId, updateNodeData]);
};

const formatPreflightIssuesSummary = (issues: ExecutionPreflightIssue[]): string => {
  if (issues.length === 0) return "";
  const first = issues[0];
  const firstMessage = first?.message ?? "";
  if (issues.length === 1) return `无法开始扩图：${firstMessage}`;
  return `有 ${issues.length} 处需要先处理（已在节点上标出）：${firstMessage} 等`;
};
