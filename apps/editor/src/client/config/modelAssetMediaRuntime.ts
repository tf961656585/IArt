import { filesToInlineDataListWithMeta } from '@/features/models/shared/formTransforms';
import {
  assertMediaReferencesResolved,
  normalizeMediaInput,
  resolveAllNormalizedMediaReferences,
} from '@/features/models/shared/mediaReferenceResolver';
import { enforceMediaResolvePolicy } from '@/features/models/shared/mediaResolvePolicy';
import type {
  ModelAssetNodeProjectionRuntimeBuildContentBlocksOptions,
  ModelAssetNodeProjectionRuntimeContentInlineDataPartOption,
  ModelAssetNodeProjectionRuntimeContentPartOption,
  ModelAssetNodeProjectionRuntimeContentTextPartOption,
  ModelAssetNodeProjectionRuntimePrepareAudioUrlOptions,
  ModelAssetNodeProjectionRuntimeResolveAutoAudioFlagOptions,
} from '@iart/contracts/model-asset-contract';
import {
  normalizeString,
  toNumberOrUndefined,
} from './modelAssetProjectionShared';
import { evaluateRuntimeValueRule, type RuntimeEvaluationContext } from './modelAssetRuntimeValues';

type RuntimeInlineDataList = Awaited<ReturnType<typeof filesToInlineDataListWithMeta>>['inlineDataList'];
type InlineDataLike = RuntimeInlineDataList[number];
type RuntimeContentTextPart = { text: string };
type RuntimeContentInlineDataPart = { inline_data: InlineDataLike };
type RuntimeContentPart = RuntimeContentTextPart | RuntimeContentInlineDataPart;
type RuntimeContentBlock = { role: string; parts: RuntimeContentPart[] };

const normalizeAllowedStringSet = (value: unknown): Set<string> =>
  new Set(
    Array.isArray(value)
      ? value
          .map((item) => normalizeString(item).toLowerCase())
          .filter(Boolean)
      : [],
  );

const inferAudioExtFromMimeType = (mimeType: string): string => {
  const normalized = normalizeString(mimeType).toLowerCase();
  if (normalized === 'audio/mpeg') return 'mp3';
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return 'wav';
  const slashIndex = normalized.indexOf('/');
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    return normalized.slice(slashIndex + 1) || 'bin';
  }
  return 'bin';
};

const createFileLike = (blob: Blob, name: string, type: string): File => {
  if (typeof File !== 'undefined') {
    return new File([blob], name, { type });
  }
  const fallback = new Blob([blob], { type }) as Blob & {
    name: string | undefined;
    lastModified: number | undefined;
  };
  fallback.name = name;
  fallback.lastModified = Date.now();
  return fallback as File;
};

const readAudioDurationSeconds = async (blob: Blob): Promise<number> => {
  if (
    typeof Audio !== 'undefined'
    && typeof URL !== 'undefined'
    && typeof URL.createObjectURL === 'function'
    && typeof URL.revokeObjectURL === 'function'
  ) {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const audio = new Audio();
      audio.preload = 'metadata';

      const duration = await new Promise<number>((resolve, reject) => {
        const timer = globalThis.setTimeout(() => {
          reject(new Error('读取音频时长超时，请更换音频文件后重试。'));
        }, 12_000);

        const cleanup = () => {
          globalThis.clearTimeout(timer);
          audio.removeEventListener('loadedmetadata', onLoaded);
          audio.removeEventListener('error', onError);
        };

        const onLoaded = () => {
          cleanup();
          resolve(audio.duration);
        };

        const onError = () => {
          cleanup();
          reject(new Error('无法读取音频时长，请确认音频为 mp3/wav 且未损坏。'));
        };

        audio.addEventListener('loadedmetadata', onLoaded, { once: true });
        audio.addEventListener('error', onError, { once: true });
        audio.src = objectUrl;
      });

      return duration;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  if (typeof AudioContext !== 'undefined') {
    const audioContext = new AudioContext();
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      return audioBuffer.duration;
    } finally {
      await audioContext.close();
    }
  }

  throw new Error('当前环境无法校验音频时长，请在浏览器/桌面端中重新选择音频后再试。');
};

const validatePreparedAudioFile = async (
  file: File,
  options: ModelAssetNodeProjectionRuntimePrepareAudioUrlOptions,
): Promise<void> => {
  const allowedMimeTypes = normalizeAllowedStringSet(options.allowed_mime_types);
  const allowedExtensions = normalizeAllowedStringSet(options.allowed_extensions);
  const maxSizeBytes = toNumberOrUndefined(options.max_size_bytes);
  const minDurationSeconds = toNumberOrUndefined(options.min_duration_seconds);
  const maxDurationSeconds = toNumberOrUndefined(options.max_duration_seconds);

  if (typeof maxSizeBytes === 'number' && file.size > maxSizeBytes) {
    throw new Error('音频文件大小不能超过 15MB。');
  }

  const mimeType = normalizeString(file.type).toLowerCase().split(';')[0] ?? '';
  const fileName = normalizeString(file.name);
  const dotIndex = fileName.lastIndexOf('.');
  const extension = dotIndex >= 0 && dotIndex < fileName.length - 1
    ? fileName.slice(dotIndex + 1).toLowerCase()
    : '';

  const mimeAllowed = allowedMimeTypes.size === 0 || allowedMimeTypes.has(mimeType);
  const extensionAllowed = allowedExtensions.size === 0 || allowedExtensions.has(extension);
  if (!mimeAllowed && !extensionAllowed) {
    throw new Error('仅支持 wav、mp3 格式的音频。');
  }

  if (
    typeof minDurationSeconds === 'number'
    || typeof maxDurationSeconds === 'number'
  ) {
    const duration = await readAudioDurationSeconds(file);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('无法读取音频时长，请确认音频文件有效。');
    }
    if (
      (typeof minDurationSeconds === 'number' && duration < minDurationSeconds)
      || (typeof maxDurationSeconds === 'number' && duration > maxDurationSeconds)
    ) {
      throw new Error('音频时长需在 3～30 秒之间。');
    }
  }
};

export const evaluatePrepareAudioUrl = async (
  options: ModelAssetNodeProjectionRuntimePrepareAudioUrlOptions,
  context: RuntimeEvaluationContext,
): Promise<unknown> => {
  const sourceValue = await evaluateRuntimeValueRule(options.source, context);
  const items = normalizeMediaInput(sourceValue, 1);
  if (items.length === 0) {
    return undefined;
  }

  const [first] = items;
  if (!first) {
    return undefined;
  }
  if (first.source.type === 'url') {
    const rawUrl = normalizeString(first.source.url);
    const lowerUrl = rawUrl.toLowerCase();
    if (!lowerUrl.startsWith('http://') && !lowerUrl.startsWith('https://')) {
      throw new Error('这个音频地址无法读取，请改用本机文件或 https 开头的地址。');
    }
    return rawUrl;
  }

  const resolved = await resolveAllNormalizedMediaReferences([first], 'upload-file');
  assertMediaReferencesResolved(resolved.errors);
  {
    const entry = resolved.items[0];
    if (entry === undefined || entry.file === undefined) {
      throw new Error('无法解析音频输入，请重新选择音频文件后再试。');
    }

    let file: File;
    if (typeof File !== 'undefined' && entry.file instanceof File) {
      file = entry.file;
    } else {
      const mimeType = normalizeString(entry.mimeType || entry.file.type) || 'application/octet-stream';
      const extension = inferAudioExtFromMimeType(mimeType);
      file = createFileLike(entry.file, `audio_${Date.now()}.${extension}`, mimeType);
    }

    await validatePreparedAudioFile(file, options);
    return file;
  }
};

export const evaluateResolveAutoAudioFlag = async (
  options: ModelAssetNodeProjectionRuntimeResolveAutoAudioFlagOptions,
  context: RuntimeEvaluationContext,
): Promise<boolean> => {
  const audioSourceValue = await evaluateRuntimeValueRule(options.audio_source, context);
  if (normalizeMediaInput(audioSourceValue, 1).length > 0) {
    return false;
  }
  const autoAudioValue = options.auto_audio
    ? await evaluateRuntimeValueRule(options.auto_audio, context)
    : undefined;
  return Boolean(autoAudioValue);
};

const normalizeTextPartValue = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) => normalizeTextPartValue(item))
      .filter((item): item is string => item !== undefined && item !== '');
    return items.length > 0 ? items.join('\n') : undefined;
  }
  return undefined;
};

const resolveContentTextPart = async (
  part: ModelAssetNodeProjectionRuntimeContentTextPartOption,
  context: RuntimeEvaluationContext,
): Promise<RuntimeContentTextPart[]> => {
  const value = normalizeTextPartValue(await evaluateRuntimeValueRule(part.value, context));
  if ((value === undefined || value === '') && part.skip_if_empty !== false) {
    return [];
  }
  return value === undefined ? [] : [{ text: value }];
};

const resolveContentInlineDataPart = async (
  part: ModelAssetNodeProjectionRuntimeContentInlineDataPartOption,
  context: RuntimeEvaluationContext,
): Promise<RuntimeContentInlineDataPart[]> => {
  const value = await evaluateRuntimeValueRule(part.value, context);
  const maxItems = toNumberOrUndefined(part.max_items);
  const resolved = await filesToInlineDataListWithMeta(value, { limit: maxItems });
  enforceMediaResolvePolicy('strict', { errors: resolved.errors });
  const inlineDataList = part.multiple === true
    ? resolved.inlineDataList
    : resolved.inlineDataList.slice(0, 1);
  if (inlineDataList.length === 0 && part.skip_if_empty !== false) {
    return [];
  }
  return inlineDataList.map((inlineData) => ({
    inline_data: inlineData,
  }));
};

const resolveContentPart = async (
  part: ModelAssetNodeProjectionRuntimeContentPartOption,
  context: RuntimeEvaluationContext,
): Promise<RuntimeContentPart[]> => {
  if (part.part_kind === 'text') {
    return resolveContentTextPart(part, context);
  }
  return resolveContentInlineDataPart(part, context);
};

export const evaluateBuildContentBlocks = async (
  options: ModelAssetNodeProjectionRuntimeBuildContentBlocksOptions,
  context: RuntimeEvaluationContext,
): Promise<RuntimeContentBlock[] | undefined> => {
  const parts: RuntimeContentPart[] = [];
  for (const part of options.parts) {
    parts.push(...(await resolveContentPart(part, context)));
  }
  if (parts.length === 0) {
    return undefined;
  }
  return [
    {
      role: normalizeString(options.role) || 'user',
      parts,
    },
  ];
};
