'use client';

import { extractMediaUrls } from '@/client/utils/outputNormalize';
import { applyModelDefaultsToPayload } from '@/client/utils/generationPayload';
import { resolveRuntimeProjectedImageToImageModel } from '@/client/config/runtimeModelSelection';
import { buildPayloadFromConfig } from '@/features/workspace/modelFormAdapter';
import type { CommonImageToImageFieldKey } from '@/features/workspace/schema/commonModelFieldKeys';
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from '@iart/contracts';
import { submitFormalCanvasTask } from '@/client/api/client';
import { getRuntimeProjectPath } from '@/client/store/runtimeStore';
import { ensureLocalFilesImageUrl } from '../utils/mediaUtils';
import type { ImageGenerationAspectRatio, ImageGenerationSize } from '@/features/models/shared/imageGenerationOptions';

export type ImageOutpaintRequest = {
  modelId: string;
  sourceImage: Blob | string;
  aspectRatio: ImageGenerationAspectRatio;
  imageSize: ImageGenerationSize;
  userPrompt: string | undefined;
  taskBinding: {
    clientTaskRef: string;
    taskIndex: number;
    targetNodeId: string;
    nodeGraphId: string | undefined;
    sourceNodeId: string | undefined;
  } | undefined;
  onTaskAccepted: (taskId: string) => void | undefined;
};

export type ImageOutpaintResult =
  | {
      kind: 'completed';
      /** /files/... */
      url: string;
      raw: unknown;
      promptUsed: string;
      modelId: string;
    }
  | {
      kind: 'backend-task-pending';
      raw: unknown;
      promptUsed: string;
      modelId: string;
      taskId: string | undefined;
    };

const OUTPAINT_PRESET_PROMPT = `
你是“扩图（outpainting）助手”。

输入是一张图片：原图区域已经完整呈现；扩展出来的空白区域为纯白色（#FFFFFF）。

任务要求：
- 只在白色空白区域进行补全与延展，使其与原图自然无缝衔接（透视、光照、色彩、材质、风格一致）。
- 不要改变原图已有内容（人物、物体、文字、纹理尽量保持不变）。
- 不要在画面中生成任何文字、水印、边框或签名。

请输出一张完整图片。
`.trim();

/**
 * 扩图实际提交的 prompt（预设 + 用户补充）。
 * 提交链路（outpaintImageWithModel）与前置校验（imageOutpaintPreflight）共用同一拼装，禁止双实现。
 */
export const buildOutpaintPrompt = (userPrompt: string | undefined): string => {
  const extra = typeof userPrompt === 'string' ? userPrompt.trim() : '';
  if (!extra) return OUTPAINT_PRESET_PROMPT;
  return `${OUTPAINT_PRESET_PROMPT}\n\n用户补充：\n${extra}`.trim();
};

const IMPORT_LOCAL_MEDIA_CHANNEL = 'storage:import-local-media';

type StorageImportLocalMediaResult = {
  url: string;
};

type TaskSubmissionProbe = {
  __backend_task_pending: unknown | undefined;
  taskId: unknown | undefined;
  submitted: unknown | undefined;
};

const asTaskSubmissionProbe = (value: unknown): TaskSubmissionProbe | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as TaskSubmissionProbe;
  return {
    __backend_task_pending: record.__backend_task_pending,
    taskId: record.taskId,
    submitted: record.submitted,
  };
};

async function resolveOutpaintSourceImage(sourceImage: Blob | string): Promise<string> {
  if (typeof sourceImage === 'string') {
    return sourceImage;
  }

  const projectPath = getRuntimeProjectPath();
  if (!projectPath) {
    throw new Error('还没有打开项目，无法读取扩图原图');
  }

  const importLocalMedia = (window.electron !== null && window.electron !== undefined && window.electron.storage !== null && window.electron.storage !== undefined ? window.electron.storage[IMPORT_LOCAL_MEDIA_CHANNEL] : undefined) as
    | ((args: {
        projectPath: string;
        fileDataBase64: string;
        mimeType: string;
        originalFileName: string;
      }) => Promise<StorageImportLocalMediaResult>)
    | undefined;

  if (typeof importLocalMedia !== 'function') {
    throw new Error('当前环境无法保存文件，请在桌面应用里操作');
  }

  const file = sourceImage instanceof File
    ? sourceImage
    : new File([sourceImage], 'source.png', { type: sourceImage.type || 'image/png' });
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 8192;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  const result = await importLocalMedia({
    projectPath,
    fileDataBase64: btoa(binary),
    mimeType: file.type || 'image/png',
    originalFileName: file.name || 'source.png',
  });

  return result.url;
}

export async function outpaintImageWithModel(req: ImageOutpaintRequest): Promise<ImageOutpaintResult> {
  const modelId = typeof req.modelId === 'string' ? req.modelId.trim() : '';
  const config = resolveRuntimeProjectedImageToImageModel(modelId);
  if (!config) {
    throw new Error('还没有可用的补图模型，请先选择。');
  }

  const promptUsed = buildOutpaintPrompt(req.userPrompt);
  const sourceImageUrl = await resolveOutpaintSourceImage(req.sourceImage);

  const values: Record<CommonImageToImageFieldKey, unknown> = {
    [MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY]: promptUsed,
    images: [sourceImageUrl],
    aspectRatio: req.aspectRatio,
    imageSize: req.imageSize,
  };

  const payload = await buildPayloadFromConfig(config, values);
  const normalizedPayload = applyModelDefaultsToPayload(payload, config);

  const taskBinding = req.taskBinding;
  const taskMeta = {
    scope: 'canvas',
    op: 'outpaint',
    modelId: config.modelId ?? config.modelId,
    prompt: promptUsed,
    canvasPushManaged: true,
    ...(taskBinding !== undefined && taskBinding.clientTaskRef ? { clientTaskRef: taskBinding.clientTaskRef } : {}),
    ...(taskBinding !== undefined && taskBinding.targetNodeId ? { targetNodeId: taskBinding.targetNodeId } : {}),
    ...(taskBinding !== undefined ? { taskIndex: taskBinding.taskIndex } : {}),
    ...(taskBinding !== undefined && taskBinding.nodeGraphId ? { nodeGraphId: taskBinding.nodeGraphId } : {}),
    ...(taskBinding !== undefined && taskBinding.sourceNodeId ? { sourceNodeId: taskBinding.sourceNodeId } : {}),
  };

  const raw = await submitFormalCanvasTask({
    modelId: config.modelId ?? config.modelId,
    payload: normalizedPayload,
    metadata: taskMeta,
    parameterSchema: undefined,
    ...(req.onTaskAccepted ? { onTaskAccepted: req.onTaskAccepted } : {}),
  });
  const submissionProbe = asTaskSubmissionProbe(raw);
  if (submissionProbe !== null && submissionProbe.__backend_task_pending) {
    const taskId = typeof submissionProbe.taskId === 'string' ? submissionProbe.taskId : undefined;
    return {
      kind: 'backend-task-pending',
      raw,
      promptUsed,
      modelId,
      taskId,
    };
  }
  if (submissionProbe !== null && submissionProbe.submitted === true) {
    throw new Error('扩图执行链仅接受 __backend_task_pending + taskId，不再接受 submitted 兼容回执');
  }
  const media = extractMediaUrls(raw);
  const first = media.images[0];
  if (!first) {
    throw new Error('模型这次没有返回可用的图片，请重试');
  }

  const url = await ensureLocalFilesImageUrl(first);
  return { kind: 'completed', url, raw, promptUsed, modelId };
}
