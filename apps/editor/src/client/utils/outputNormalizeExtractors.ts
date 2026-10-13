// 媒体输出归一化工具（与任务执行逻辑解耦的纯函数集合）
// 职责：从任意模型返回的原始对象中提取图片/视频/或可展示文本，并转换为统一结构
// - 避免在 React hook 中夹杂大量解析逻辑
// - 便于为将来新模型（音频 / PDF / 多模态）扩展


export interface NormalizedMediaOutput {
  images: { url: string }[] | undefined;
  videos: { url: string }[] | undefined;
  raw: unknown | undefined;
}

export type NormalizedOutput = NormalizedMediaOutput | string | null;

export const isNormalizedMediaOutput = (value: unknown): value is NormalizedMediaOutput => {
  return typeof value === 'object' && value !== null;
};

export interface InlineDataRawObject {
  data: unknown | undefined;
  mime_type: unknown | undefined;
  mimeType: unknown | undefined;
}

export interface DraftInfoRawObject {
  kind: unknown | undefined;
}

export interface ModelOutputRawObject {
  b64: unknown | undefined;
  b64_json: unknown | undefined;
  b64Json: unknown | undefined;
  base64: unknown | undefined;
  candidates: unknown | undefined;
  content: unknown | undefined;
  data: unknown | undefined;
  detail: unknown | undefined;
  download_url: unknown | undefined;
  draft_info: unknown | undefined;
  draftInfo: unknown | undefined;
  file_url: unknown | undefined;
  files: unknown | undefined;
  image_base64: unknown | undefined;
  image_url: unknown | undefined;
  imageUrl: unknown | undefined;
  images: unknown | undefined;
  kind: unknown | undefined;
  inline_data: unknown | undefined;
  inlineData: unknown | undefined;
  mime_type: unknown | undefined;
  mimeType: unknown | undefined;
  output_url: unknown | undefined;
  outputs: unknown | undefined;
  parts: unknown | undefined;
  raw: unknown | undefined;
  result_url: unknown | undefined;
  src: unknown | undefined;
  text: unknown | undefined;
  thought: unknown | undefined;
  thoughtSignature: unknown | undefined;
  url: unknown | undefined;
  video_url: unknown | undefined;
  videoUrl: unknown | undefined;
}

export const isRawObject = (value: unknown): value is ModelOutputRawObject => {
  return typeof value === 'object' && value !== null;
};

export const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export const VIDEO_EXT_REGEX = /\.(mp4|mov|webm|mkv)(\?|$)/i;
export const IMAGE_EXT_REGEX = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i;
export const MEDIA_URL_REGEX = /https?:\/\/[^\s)]+/gi;

export const getDynamicProperty = (source: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor !== undefined ? descriptor.value : undefined;
};

export const pickInlineData = (record: ModelOutputRawObject): InlineDataRawObject | null => {
  if (isRawObject(record.inline_data)) return record.inline_data;
  if (isRawObject(record.inlineData)) return record.inlineData;
  return null;
};

export const toDraftInfoRawObject = (value: ModelOutputRawObject): DraftInfoRawObject => {
  return { kind: value.kind };
};

export const pickInlineMime = (inlineData: InlineDataRawObject): string => {
  if (typeof inlineData.mime_type === 'string') return inlineData.mime_type;
  if (typeof inlineData.mimeType === 'string') return inlineData.mimeType;
  return '';
};

export const pickB64Json = (record: ModelOutputRawObject): string | null => {
  if (typeof record.b64_json === 'string') return record.b64_json;
  if (typeof record.b64Json === 'string') return record.b64Json;
  return null;
};

export const pickMediaCandidate = (record: ModelOutputRawObject): unknown => {
  return record.url ?? record.video_url ?? record.videoUrl ?? record.image_url ?? record.imageUrl ?? record.src;
};

const pickPreferredMediaCandidate = (record: ModelOutputRawObject): unknown => {
  return (
    record.video_url ??
    record.result_url ??
    record.output_url ??
    record.file_url ??
    record.url ??
    record.image_url ??
    record.imageUrl ??
    record.src
  );
};

export const extractStringCandidates = (value: unknown): string[] => {
  if (isString(value)) {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    const collected: string[] = [];
    for (const item of value) {
      collected.push(...extractStringCandidates(item));
    }
    return collected;
  }

  if (isRawObject(value)) {
    const inlineData = pickInlineData(value);
    if (inlineData) {
      const data = inlineData.data;
      const mime = pickInlineMime(inlineData);
      if (isString(data)) {
        const normalized = data.trim().replace(/\s+/g, '');
        if (normalized) {
          const normalizedMime = mime && mime.trim() ? mime.trim() : 'image/png';
          return [`data:${normalizedMime};base64,${normalized}`];
        }
      }
    }

    const b64json = pickB64Json(value);
    if (b64json) {
      const normalized = b64json.trim().replace(/\s+/g, '');
      if (normalized) {
        return [`data:image/png;base64,${normalized}`];
      }
    }

    const candidate = pickMediaCandidate(value);
    if (isString(candidate)) {
      const trimmed = candidate.trim();
      return trimmed ? [trimmed] : [];
    }
  }

  return [];
};

// 递归提取媒体 URL（含 Gemini inline_data base64 支持）
export const extractMediaUrls = (obj: unknown): { images: string[]; videos: string[] } => {
  const images: string[] = [];
  const videos: string[] = [];

  const isLikelyBase64 = (s: string) => {
    const sanitized = s.replace(/\s+/g, '');
    if (sanitized.length <= 100) return false;
    if (sanitized.length % 4 !== 0) return false;
    return /^[A-Za-z0-9+/=]+$/.test(sanitized);
  };

  const normalizeBase64Payload = (value: string): string | null => {
    if (!isString(value)) return null;
    const sanitized = value.trim().replace(/\s+/g, '');
    if (sanitized.length <= 100) return null;
    if (!/^[A-Za-z0-9+/=]+$/.test(sanitized)) return null;
    return sanitized;
  };

  const extractPreferredInlineMediaFromRecord = (
    record: ModelOutputRawObject
  ): { kind: 'image' | 'video'; url: string } | null => {
    const inlineData = pickInlineData(record);
    if (inlineData) {
      const normalized = normalizeBase64Payload(typeof inlineData.data === 'string' ? inlineData.data : '');
      if (normalized) {
        const mimeValue = pickInlineMime(inlineData);
        const mime = mimeValue && mimeValue.trim() ? mimeValue.trim() : 'image/png';
        if (mime.startsWith('video/')) {
          return { kind: 'video', url: `data:${mime};base64,${normalized}` };
        }
        if (mime.startsWith('image/')) {
          return { kind: 'image', url: `data:${mime};base64,${normalized}` };
        }
        return null;
      }
    }

    const b64json = pickB64Json(record);
    const normalizedB64 = b64json ? normalizeBase64Payload(b64json) : null;
    if (normalizedB64) {
      return { kind: 'image', url: `data:image/png;base64,${normalizedB64}` };
    }

    return null;
  };

  const pushIfUrl = (candidate: unknown) => {
    if (!isString(candidate)) return;
    const normalized = candidate.trim();
    if (!normalized) return;

    if (normalized.startsWith('base64,')) {
      const sanitized = normalized.slice('base64,'.length).replace(/\s+/g, '');
      if (sanitized.length > 0) {
        images.push(`data:image/png;base64,${sanitized}`);
      }
      return;
    }

    if (isLikelyBase64(normalized)) {
      images.push(`data:image/png;base64,${normalized.replace(/\s+/g, '')}`);
      return;
    }

    if (/^data:video\//i.test(normalized) || VIDEO_EXT_REGEX.test(normalized)) {
      videos.push(normalized);
      return;
    }

    if (/^data:image\//i.test(normalized)) {
      images.push(normalized);
      return;
    }

    if (IMAGE_EXT_REGEX.test(normalized)) {
      const hasPathOrProtocol = /[/:\\]/.test(normalized);
      if (!hasPathOrProtocol) {
        return;
      }

      images.push(normalized);
      return;
    }

    if (/^https?:\/\//i.test(normalized)) {
      if (VIDEO_EXT_REGEX.test(normalized)) {
        videos.push(normalized);
        return;
      }

      if (IMAGE_EXT_REGEX.test(normalized)) {
        images.push(normalized);
        return;
      }

      images.push(normalized);
      return;
    }

    // 支持从 Markdown 文本中提取图片 URL（如 ![image](https://...)）
    // 用于处理 OpenAI Chat Completions 风格的图像生成响应
    const markdownImageMatches = normalized.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi);
    for (const match of markdownImageMatches) {
      const extractedUrl = match[1];
      if (!extractedUrl) continue;
      if (VIDEO_EXT_REGEX.test(extractedUrl)) {
        videos.push(extractedUrl);
      } else {
        images.push(extractedUrl);
      }
    }
  };

  const pushInlineBase64 = (inlineObj: unknown) => {
    if (!isRawObject(inlineObj)) return;
    const inlineData: InlineDataRawObject = inlineObj;
    const data = inlineData.data;
    const mimeValue = pickInlineMime(inlineData);

    if (!isString(data)) return;
    const sanitized = data.replace(/\s+/g, '');
    if (!sanitized) return;

    const mime = mimeValue && mimeValue.trim() ? mimeValue.trim() : 'image/png';

    if (mime.startsWith('video/')) {
      videos.push(`data:${mime};base64,${sanitized}`);
      return;
    }

    if (mime.startsWith('image/')) {
      images.push(`data:${mime};base64,${sanitized}`);
    }
  };

  const visited = new WeakSet<object>();
  const walk = (value: unknown) => {
    if (!isRawObject(value)) return;
    if (visited.has(value)) return;
    visited.add(value);

    const preferredInlineMedia = extractPreferredInlineMediaFromRecord(value);
    const preferInlineImage = (preferredInlineMedia !== null && preferredInlineMedia !== undefined ? preferredInlineMedia.kind : undefined) === 'image';

    if (preferredInlineMedia) {
      if (preferredInlineMedia.kind === 'video') {
        videos.push(preferredInlineMedia.url);
      } else {
        images.push(preferredInlineMedia.url);
      }
    } else {
      pushIfUrl(pickPreferredMediaCandidate(value));
    }

    if (Array.isArray(value.candidates)) {
      value.candidates.forEach(walk);
    }

    // 支持 Gemini 的 candidates[].content 结构
    if (isRawObject(value.content)) {
      walk(value.content);
    }

    if (Array.isArray(value.parts)) {
      for (const part of value.parts) {
        if (isRawObject(part)) {
          // 跳过只包含 thoughtSignature 的 part,避免无意义的 DFS
          const shouldSkipPart =
            typeof part.thoughtSignature === 'string' &&
            Object.keys(part).every((key) => key === 'thoughtSignature' || key === 'role');
          if (shouldSkipPart) {
            continue;
          }

          if (part.inline_data) pushInlineBase64(part.inline_data);
          if (part.inlineData) pushInlineBase64(part.inlineData);
          if (part.content) {
            if (isRawObject(part.content)) {
              pushIfUrl(part.content.url ?? part.content);
            } else {
              pushIfUrl(part.content);
            }
          }
          walk(part);
        }
      }
    }

    if (Array.isArray(value.images)) {
      for (const item of value.images) {
        if (isString(item)) {
          pushIfUrl(item);
        } else if (isRawObject(item)) {
          pushIfUrl(item.url ?? item.image_url ?? item.imageUrl ?? item.src ?? item.content);
        }
      }
    }

    if (Array.isArray(value.files)) {
      for (const file of value.files) {
        if (isString(file)) {
          pushIfUrl(file);
        } else if (isRawObject(file)) {
          pushIfUrl(file.url ?? file.download_url ?? file.file_url ?? file.src);
        }
      }
    }

    if (Array.isArray(value.outputs)) {
      for (const output of value.outputs) {
        if (isString(output)) {
          pushIfUrl(output);
        } else if (isRawObject(output)) {
          if (output.content) {
            if (isRawObject(output.content)) {
              pushIfUrl(output.content.url ?? output.content);
            } else {
              pushIfUrl(output.content);
            }
          } else {
            pushIfUrl(output.url ?? output.image_url ?? output.src);
          }
        }
        walk(output);
      }
    }

    if (!preferredInlineMedia) {
      if (value.inline_data) pushInlineBase64(value.inline_data);
      if (value.inlineData) pushInlineBase64(value.inlineData);
    }

    if (value.raw) walk(value.raw);
    if (value.detail) walk(value.detail);

    // 跳过 Gemini inline_data 的 data 字段,避免在 pushInlineBase64 后再次处理
    const hasInlineMime = typeof value.mime_type === 'string' || typeof value.mimeType === 'string';
    if (value.data && !hasInlineMime) {
      const dataValue = value.data;
      if (isString(dataValue)) pushIfUrl(dataValue);
      else walk(dataValue);
    }

    for (const key of Object.keys(value)) {
      const lowerKey = key.toLowerCase();
      // 部分历史模型响应中，input / inputs 通常承载的是“请求输入”（参考图、首帧等），
      // 而非模型生成结果；这里显式跳过这些分支，避免在本地任务结果里把输入资源当成输出渲染。
      // Gemini 的 contents 和 body 字段同样包含请求输入，也需要跳过。
      if (
        lowerKey === 'input' ||
        lowerKey === 'inputs' ||
        lowerKey === 'contents' ||
        lowerKey === 'body' ||
        (preferInlineImage &&
          (lowerKey === 'url' ||
            lowerKey === 'image_url' ||
            lowerKey === 'imageurl' ||
            lowerKey === 'src' ||
            lowerKey === 'b64_json' ||
            lowerKey === 'b64json' ||
            lowerKey === 'inline_data' ||
            lowerKey === 'inlinedata')) ||
        (lowerKey === 'data' && hasInlineMime) ||
        key === 'thoughtSignature' ||
        lowerKey === 'thoughtsignature'
      ) {
        continue;
      }

      const nested = getDynamicProperty(value, key);
      if (isRawObject(nested) || Array.isArray(nested)) {
        walk(nested);
      } else {
        pushIfUrl(nested);
      }
    }
  };

  walk(obj);
  return { images: Array.from(new Set(images)), videos: Array.from(new Set(videos)) };
};
