import { isFormDataLike } from '../utils/http';
import type { ModelAssetNodeProjectionParameterSchema } from '@iart/contracts/model-asset-contract';
import type { TaskSubmitMediaInput, TaskSubmitMediaKind } from '@iart/contracts/task-submit-media-input';
import type { DynamicPayload, SubmitFormalCanvasTaskOptions, SubmitFormalCanvasTaskResult, TaskMetadata } from './clientTypes';
import { arrayBufferToBase64, collectFormDataEntries, isBlobLike } from './formDataSerializer';
import { request } from './transport';

const SCHEMA_GENERATION_PAYLOAD_STRUCTURAL_KEYS = new Set([
  'body',
  'api',
  'meta',
]);

const isPlainObject = (value: unknown): value is DynamicPayload =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 媒体上传类型的 component 值集合，这些字段应被视为媒体输入 */
const MEDIA_UPLOAD_COMPONENTS = new Set(['imageUpload', 'file']);

/**
 * 从 parameter_schema 的 fields 数组中收集媒体字段的 field_key。
 * 当 component 为 imageUpload 或 file 时，视为媒体字段。
 * 如果 parameter_schema 为空或 fields 不是数组，返回空 Set。
 */
const collectMediaFieldKeysFromParameterSchema = (
  parameterSchema: unknown | undefined,
): Set<string> => {
  if (parameterSchema === undefined || parameterSchema === null) return new Set();
  if (typeof parameterSchema !== 'object') return new Set();
  const schema = parameterSchema as ModelAssetNodeProjectionParameterSchema;
  const fields = schema.fields;
  if (!Array.isArray(fields)) return new Set();
  const keys = new Set<string>();
  for (const field of fields) {
    if (field === null || field === undefined || typeof field !== 'object') continue;
    const component = typeof field.component === 'string' ? field.component : '';
    const fieldKey = typeof field.field_key === 'string' ? field.field_key : '';
    if (component.length > 0 && fieldKey.length > 0 && MEDIA_UPLOAD_COMPONENTS.has(component)) {
      keys.add(fieldKey);
    }
  }
  return keys;
};

const normalizeTaskSubmitString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const inferTaskSubmitMediaKind = (mimeType: string): TaskSubmitMediaKind => {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('audio/')) return 'audio';
  return 'image';
};

const inferMediaKindFromSrc = (src: string): TaskSubmitMediaKind => {
  const withoutQuery = src.split('?');
  const firstSegment = withoutQuery[0];
  if (firstSegment === undefined) return 'image';
  const withoutHash = firstSegment.split('#');
  const pathSegment = withoutHash[0];
  if (pathSegment === undefined) return 'image';
  const path = pathSegment.toLowerCase();
  const lastDot = path.lastIndexOf('.');
  if (lastDot < 0) return 'image';
  const ext = path.slice(lastDot + 1);
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp' || ext === 'gif' || ext === 'bmp' || ext === 'svg' || ext === 'avif' || ext === 'tiff' || ext === 'tif') return 'image';
  if (ext === 'mp4' || ext === 'webm' || ext === 'mov' || ext === 'avi' || ext === 'mkv' || ext === 'm4v' || ext === 'flv' || ext === 'wmv' || ext === '3gp') return 'video';
  if (ext === 'mp3' || ext === 'wav' || ext === 'ogg' || ext === 'flac' || ext === 'aac' || ext === 'm4a' || ext === 'wma' || ext === 'opus') return 'audio';
  return 'image';
};

const inferMimeTypeFromSrc = (src: string): string => {
  const withoutQuery = src.split('?');
  const firstSegment = withoutQuery[0];
  if (firstSegment === undefined) return 'application/octet-stream';
  const withoutHash = firstSegment.split('#');
  const pathSegment = withoutHash[0];
  if (pathSegment === undefined) return 'application/octet-stream';
  const path = pathSegment.toLowerCase();
  const lastDot = path.lastIndexOf('.');
  if (lastDot < 0) return 'application/octet-stream';
  const ext = path.slice(lastDot + 1);
  const imageExts: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', tiff: 'image/tiff', tif: 'image/tiff' };
  const videoExts: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska', m4v: 'video/mp4', flv: 'video/x-flv' };
  const audioExts: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4', opus: 'audio/opus' };
  if (ext in imageExts) {
    const result = imageExts[ext];
    return result !== undefined ? result : 'application/octet-stream';
  }
  if (ext in videoExts) {
    const result = videoExts[ext];
    return result !== undefined ? result : 'application/octet-stream';
  }
  if (ext in audioExts) {
    const result = audioExts[ext];
    return result !== undefined ? result : 'application/octet-stream';
  }
  return 'application/octet-stream';
};

const buildTaskSubmitMediaInputFromBlob = async (
  blob: Blob,
  filename: string | undefined,
): Promise<TaskSubmitMediaInput> => {
  const mimeType = normalizeTaskSubmitString(blob.type) || 'application/octet-stream';
  const base64 = arrayBufferToBase64(await blob.arrayBuffer());
  return {
    media_kind: inferTaskSubmitMediaKind(mimeType),
    source_kind: 'base64',
    value: base64,
    mime_type: mimeType,
    filename: filename ? filename : null,
  };
};

const appendTaskSubmitArgument = (
  target: DynamicPayload,
  name: string,
  value: unknown,
): void => {
  if (!(name in target)) {
    target[name] = value;
    return;
  }
  const existing = target[name];
  if (Array.isArray(existing)) {
    existing.push(value);
    target[name] = existing;
    return;
  }
  target[name] = [existing, value];
};

/**
 * 检测值是否为 UploadFileItem-like 结构（{file, src, id}）。
 * UI 层的表单值可能仍以这种格式传入。
 */
const isUploadFileItemLike = (value: unknown): value is { file: File | Blob | null | undefined; src: string | null | undefined; id: string | undefined } =>
  Boolean(value) && typeof value === 'object' && ('file' in (value as object)) && !isBlobLike(value);

/**
 * 从 UploadFileItem-like 对象提取 TaskSubmitMediaInput。
 * 简化版：处理 file (Blob) 和 src（URL 或 data URL）两种来源。
 */
const buildMediaInputFromUploadLikeItem = async (
  item: { file: File | Blob | null | undefined; src: string | null | undefined },
): Promise<TaskSubmitMediaInput | null> => {
  // 有 Blob file → 转 base64
  if (item.file != null && isBlobLike(item.file)) {
    const filename = typeof File !== 'undefined' && item.file instanceof File ? item.file.name : undefined;
    return buildTaskSubmitMediaInputFromBlob(item.file, filename);
  }
  const src = typeof item.src === 'string' ? item.src.trim() : '';
  if (!src) {
    console.debug('[taskFacade] buildMediaInputFromUploadLikeItem: no extractable media', { hasFile: item.file != null });
    return null;
  }
  // data URL → 解码为 base64
  if (src.startsWith('data:')) {
    const commaIndex = src.indexOf(',');
    if (commaIndex < 0) {
      console.debug('[taskFacade] buildMediaInputFromUploadLikeItem: invalid data URL', { src: src.substring(0, 80) });
      return null;
    }
    const meta = src.slice(5, commaIndex);
    const mimePart = meta.split(';')[0];
    const base64 = src.slice(commaIndex + 1);
    if (!base64) {
      console.debug('[taskFacade] buildMediaInputFromUploadLikeItem: empty data URL payload', { src: src.substring(0, 80) });
      return null;
    }
    const mimeType = mimePart || 'application/octet-stream';
    return {
      media_kind: inferTaskSubmitMediaKind(mimeType),
      source_kind: 'base64',
      value: base64,
      mime_type: mimeType,
      filename: null,
    };
  }
  // 非 data URL → 作为 URL 媒体输入
  const mediaKind = inferMediaKindFromSrc(src);
  const mimeType = inferMimeTypeFromSrc(src);
  return {
    media_kind: mediaKind,
    source_kind: 'url',
    value: src,
    mime_type: mimeType,
    filename: null,
  };
};

const normalizeTaskSubmitArgsFromFormData = async (
  formData: FormData,
): Promise<{ args: DynamicPayload; mediaInputs: TaskSubmitMediaInput[] }> => {
  const args: DynamicPayload = {};
  const mediaInputs: TaskSubmitMediaInput[] = [];

  for (const [name, value] of collectFormDataEntries(formData)) {
    if (typeof value === 'string') {
      // 尝试 JSON parse 检测 UploadFileItem-like 结构（如 {"file":null,"src":"/files/xxx.png"}）
      let parsed: unknown = undefined;
      try {
        if (value.startsWith('{')) {
          parsed = JSON.parse(value);
        }
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && isUploadFileItemLike(parsed)) {
        const media = await buildMediaInputFromUploadLikeItem(parsed);
        if (media) {
          mediaInputs.push(media);
        } else {
          console.debug('[taskFacade] normalizeTaskSubmitArgsFromFormData: JSON UploadFileItem has no extractable media, name=%s', name);
        }
        continue;
      }
      appendTaskSubmitArgument(args, name, value);
      continue;
    }
    if (isBlobLike(value)) {
      const filename = typeof File !== 'undefined' && value instanceof File ? value.name : undefined;
      mediaInputs.push(await buildTaskSubmitMediaInputFromBlob(value, filename));
      continue;
    }
    appendTaskSubmitArgument(args, name, String(value));
  }

  return { args, mediaInputs };
};

const normalizeTaskSubmitArgsFromRecord = async (
  body: DynamicPayload,
  mediaFieldKeys: Set<string>,
): Promise<{ args: DynamicPayload; mediaInputs: TaskSubmitMediaInput[] }> => {
  const args: DynamicPayload = { ...body };
  const mediaInputs: TaskSubmitMediaInput[] = [];

  const collectArrayMedia = async (raw: unknown[], fieldKey: string): Promise<{ media: TaskSubmitMediaInput[]; plain: unknown[] } | null> => {
    if (raw.length === 0) return null;
    const mediaItems: TaskSubmitMediaInput[] = [];
    const plainItems: unknown[] = [];
    let hasAnyMedia = false;

    for (const entry of raw) {
      if (isBlobLike(entry)) {
        const filename = typeof File !== 'undefined' && entry instanceof File ? entry.name : undefined;
        mediaItems.push(await buildTaskSubmitMediaInputFromBlob(entry, filename));
        hasAnyMedia = true;
        continue;
      }
      // UploadFileItem-like 对象：提取 src 或 file 作为媒体
      if (isUploadFileItemLike(entry)) {
        const media = await buildMediaInputFromUploadLikeItem(entry);
        if (media) {
          mediaItems.push(media);
          hasAnyMedia = true;
        } else {
          console.debug('[taskFacade] collectArrayMedia: UploadFileItem-like entry has no extractable media', { hasFile: entry.file != null, src: typeof entry.src === 'string' ? entry.src.substring(0, 80) : '(non-string)' });
        }
        continue;
      }
      // 媒体字段中的非空纯字符串 → 提取为 URL 媒体输入
      if (typeof entry === 'string' && entry.length > 0 && mediaFieldKeys.has(fieldKey)) {
        console.debug('[taskFacade] extracted string URL as media: fieldKey=%s, urlPrefix=%s', fieldKey, entry.substring(0, 50));
        const mediaKind = inferMediaKindFromSrc(entry);
        const mimeType = inferMimeTypeFromSrc(entry);
        mediaItems.push({
          media_kind: mediaKind,
          source_kind: 'url',
          value: entry,
          mime_type: mimeType,
          filename: null,
        });
        hasAnyMedia = true;
        continue;
      }
      plainItems.push(entry);
    }
    if (!hasAnyMedia && plainItems.length === 0) return null;
    return { media: mediaItems, plain: plainItems };
  };

  for (const [key, value] of Object.entries(body)) {
    if (isBlobLike(value)) {
      const filename = typeof File !== 'undefined' && value instanceof File ? value.name : undefined;
      mediaInputs.push(await buildTaskSubmitMediaInputFromBlob(value, filename));
      delete args[key];
      continue;
    }
    // UploadFileItem-like 对象：提取 src 或 file 作为媒体
    if (isUploadFileItemLike(value)) {
      const media = await buildMediaInputFromUploadLikeItem(value);
      if (media) {
        mediaInputs.push(media);
        delete args[key];
      } else {
        console.debug('[taskFacade] normalizeTaskSubmitArgsFromRecord: UploadFileItem-like value has no extractable media for key=%s', key);
        delete args[key];
      }
      continue;
    }
    if (Array.isArray(value)) {
      const result = await collectArrayMedia(value, key);
      if (result) {
        if (result.media.length > 0) {
          mediaInputs.push(...result.media);
        }
        if (result.plain.length > 0) {
          args[key] = result.plain.length === 1 ? result.plain[0] : result.plain;
        } else {
          delete args[key];
        }
      }
      continue;
    }
    // 媒体字段的非空纯字符串值 → 提取为 URL 媒体输入
    if (typeof value === 'string' && value.length > 0 && mediaFieldKeys.has(key)) {
      console.debug('[taskFacade] extracted string URL as media: fieldKey=%s, urlPrefix=%s', key, value.substring(0, 50));
      const mediaKind = inferMediaKindFromSrc(value);
      const mimeType = inferMimeTypeFromSrc(value);
      mediaInputs.push({
        media_kind: mediaKind,
        source_kind: 'url',
        value: value,
        mime_type: mimeType,
        filename: null,
      });
      delete args[key];
    }
  }

  return { args, mediaInputs };
};

export const normalizeTaskSubmitRequestBody = async (
  payload: unknown,
  parameterSchema: unknown | undefined,
): Promise<{ arguments: DynamicPayload; media_inputs: TaskSubmitMediaInput[] | undefined }> => {
  const mediaFieldKeys = collectMediaFieldKeysFromParameterSchema(parameterSchema);

  // 诊断 warn：mediaFieldKeys 为空但 payload 含媒体类数据 → parameter_schema 可能未正确加载
  if (mediaFieldKeys.size === 0 && isPlainObject(payload)) {
    const suspectKeys: string[] = [];
    const checkValue = (obj: DynamicPayload) => {
      for (const [key, val] of Object.entries(obj)) {
        if (isBlobLike(val)) {
          suspectKeys.push(key);
        } else if (typeof val === 'string' && val.startsWith('data:')) {
          suspectKeys.push(key);
        } else if (typeof val === 'object' && val !== null && !Array.isArray(val) && ('file' in val || 'src' in val)) {
          suspectKeys.push(key);
        } else if (Array.isArray(val)) {
          for (const item of val) {
            if (isBlobLike(item) || (typeof item === 'string' && item.startsWith('data:')) || (typeof item === 'object' && item !== null && !Array.isArray(item) && ('file' in item || 'src' in item))) {
              suspectKeys.push(key);
              break;
            }
          }
        }
      }
    };
    const { body: payloadBody } = payload;
    if (isPlainObject(payloadBody)) {
      checkValue(payloadBody);
    }
    checkValue(payload);
    if (suspectKeys.length > 0) {
      console.warn('[taskFacade] mediaFieldKeys is empty but payload contains media-like values for keys: [%s]. The parameter_schema may not be loaded correctly. These values will be treated as plain arguments, not media inputs.', suspectKeys.join(', '));
    }
  }

  // 路径 1: payload 本身是 FormData
  if (isFormDataLike(payload)) {
    const { args, mediaInputs } = await normalizeTaskSubmitArgsFromFormData(payload);
    return { arguments: args, media_inputs: mediaInputs.length > 0 ? mediaInputs : undefined };
  }
  if (isPlainObject(payload)) {
    const { body } = payload;
    // 路径 2: payload.body 是 FormData（SchemaGenerationPayload 格式）
    if (isFormDataLike(body)) {
      const { args: bodyArgs, mediaInputs } = await normalizeTaskSubmitArgsFromFormData(body);
      const args: DynamicPayload = {};
      for (const [key, value] of Object.entries(payload)) {
        if (key === 'body') continue;
        if (SCHEMA_GENERATION_PAYLOAD_STRUCTURAL_KEYS.has(key)) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          args[key] = value;
        }
      }
      for (const [key, value] of Object.entries(bodyArgs)) {
        if (!(key in args)) {
          args[key] = value;
        }
      }
      return { arguments: args, media_inputs: mediaInputs.length > 0 ? mediaInputs : undefined };
    }
    // 路径 3: payload 是普通对象且 body 不是 FormData
    const combinedArgs: DynamicPayload = {};
    const combinedMediaInputs: TaskSubmitMediaInput[] = [];

    // 1. 处理 payload.body 中的嵌套媒体数据和非媒体字段
    if (isPlainObject(body)) {
      const { args: bodyArgs, mediaInputs: bodyMedia } = await normalizeTaskSubmitArgsFromRecord(body, mediaFieldKeys);
      for (const [key, value] of Object.entries(bodyArgs)) {
        combinedArgs[key] = value;
      }
      for (const media of bodyMedia) {
        combinedMediaInputs.push(media);
      }
    }

    // 2. 处理 payload 顶层非结构性 key（提取媒体，合并普通字段，顶层覆盖 body 同名字段）
    const topLevelRecord: DynamicPayload = {};
    for (const [key, value] of Object.entries(payload)) {
      if (SCHEMA_GENERATION_PAYLOAD_STRUCTURAL_KEYS.has(key)) continue;
      topLevelRecord[key] = value;
    }
    const { args: topArgs, mediaInputs: topMedia } = await normalizeTaskSubmitArgsFromRecord(topLevelRecord, mediaFieldKeys);
    for (const [key, value] of Object.entries(topArgs)) {
      combinedArgs[key] = value;
    }
    for (const media of topMedia) {
      combinedMediaInputs.push(media);
    }

    return {
      arguments: combinedArgs,
      media_inputs: combinedMediaInputs.length > 0 ? combinedMediaInputs : undefined,
    };
  }
  return { arguments: {}, media_inputs: undefined };
};

export async function submitFormalCanvasTask(
  options: SubmitFormalCanvasTaskOptions,
): Promise<SubmitFormalCanvasTaskResult> {
  const modelId = normalizeTaskSubmitString(options.modelId);
  if (!modelId) throw new Error('submitFormalCanvasTask requires modelId');

  const normalized = await normalizeTaskSubmitRequestBody(options.payload, options.parameterSchema);
  const metadata: TaskMetadata = isPlainObject(options.metadata) ? options.metadata : {};
  const projectPath = normalizeTaskSubmitString(metadata.projectPath);

  const raw = await request<{ taskId: unknown | undefined }>({
    method: 'POST',
    endpoint: '/api/tasks',
    body: {
      model_id: modelId,
      arguments: normalized.arguments,
      ...(normalized.media_inputs ? { media_inputs: normalized.media_inputs } : {}),
      ...(projectPath ? { projectPath } : {}),
      ...(options.mentionMap ? { mention_map: options.mentionMap } : {}),
      metadata,
    },
  });

  const taskId = normalizeTaskSubmitString(raw.taskId);
  if (!taskId) throw new Error('任务没能提交成功，请重试。');

  if (options.onTaskAccepted) options.onTaskAccepted(taskId);
  return { __backend_task_pending: true, taskId, raw };
}
