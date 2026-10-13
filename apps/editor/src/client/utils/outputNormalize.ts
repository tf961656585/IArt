// 媒体输出归一化工具（与任务执行逻辑解耦的纯函数集合）
// 职责：从任意模型返回的原始对象中提取图片/视频/或可展示文本，并转换为统一结构

import {
  extractMediaUrls,
  isRawObject,
  isString,
  type NormalizedMediaOutput,
  type NormalizedOutput,
  VIDEO_EXT_REGEX,
  IMAGE_EXT_REGEX,
  MEDIA_URL_REGEX,
} from './outputNormalizeExtractors';

export { extractWithConfig, getValueByPath } from './outputNormalizeConfig';
export { extractMediaUrls, isNormalizedMediaOutput } from './outputNormalizeExtractors';
export type { NormalizedMediaOutput, NormalizedOutput } from './outputNormalizeExtractors';

export const extractGeminiTextContent = (obj: unknown): string | null => {
  const texts: string[] = [];
  const thoughts: string[] = [];
  const visited = new WeakSet<object>();

  const walk = (value: unknown): void => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isRawObject(value)) return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value.candidates)) {
      for (const candidate of value.candidates) walk(candidate);
    }
    if (isRawObject(value.content)) walk(value.content);

    if (Array.isArray(value.parts)) {
      for (const part of value.parts) {
        if (!isRawObject(part)) continue;
        const thoughtFlag = part.thought;
        const isThought = typeof thoughtFlag === 'boolean' ? thoughtFlag : thoughtFlag === 'true';
        if (isString(part.text)) {
          if (isThought) {
            thoughts.push(part.text);
          } else {
            texts.push(part.text);
          }
        }
        walk(part);
      }
    }

    if (value.raw !== undefined) walk(value.raw);
    if (value.detail !== undefined) walk(value.detail);
    if (value.data !== undefined) walk(value.data);
  };

  walk(obj);

  // 优先返回非思考内容
  const merged = texts.join('\n');
  if (merged.trim().length > 0) {
    return merged;
  }

  // 如果没有非思考内容，返回思考内容作为 fallback
  // 这种情况可能发生在 thinking 模型只输出了思考过程时
  const mergedThoughts = thoughts.join('\n');
  if (mergedThoughts.trim().length > 0) {
    console.warn('[extractGeminiTextContent] 响应只包含思考内容，将思考内容作为输出返回');
    return mergedThoughts;
  }

  return null;
};

const isChatCompletionStream = (text: string): boolean => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('data:')) {
    return false;
  }
  return /"object"\s*:\s*"chat\.completion/i.test(text);
};

const normalizeStreamText = (rawText: string): NormalizedMediaOutput => {
  const normalizedText = rawText.replace(/\r\n/g, '\n');
  const textForRaw = normalizedText.trim() ? normalizedText.trim() : normalizedText;

  const urlMatches = normalizedText.match(MEDIA_URL_REGEX) ?? [];
  const uniqueUrls = Array.from(new Set(urlMatches));

  const images = uniqueUrls.filter((url) => IMAGE_EXT_REGEX.test(url) || url.startsWith('data:image/'));
  const videos = uniqueUrls.filter((url) => VIDEO_EXT_REGEX.test(url) || url.startsWith('data:video/'));

  const result: NormalizedMediaOutput = { images: undefined, videos: undefined, raw: textForRaw };
  if (images.length > 0) {
    result.images = images.map((url) => ({ url }));
  }
  if (videos.length > 0) {
    result.videos = videos.map((url) => ({ url }));
  }

  return result;
};

export const normalizeFinalData = (finalData: unknown): NormalizedOutput => {
  if (finalData == null) return null;
  if (typeof finalData === 'string') {
    if (isChatCompletionStream(finalData)) {
      return normalizeStreamText(finalData);
    }
    return finalData;
  }

  const geminiText = extractGeminiTextContent(finalData);

  const media = extractMediaUrls(finalData);
  const hasImages = media.images.length > 0;
  const hasVideos = media.videos.length > 0;

  if (hasImages || hasVideos) {
    const result: NormalizedMediaOutput = { images: undefined, videos: undefined, raw: geminiText ?? finalData };
    if (hasImages) {
      result.images = media.images.map((url) => ({ url }));
    }
    if (hasVideos) {
      result.videos = media.videos.map((url) => ({ url }));
    }
    return result;
  }

  if (geminiText) {
    return geminiText;
  }

  if (isRawObject(finalData)) {
    const directUrl = finalData.url ?? finalData.image_url ?? finalData.imageUrl ?? finalData.src;
    if (isString(directUrl)) return { images: [{ url: directUrl }], videos: undefined, raw: finalData };

    const base64 = finalData.image_base64 ?? finalData.base64 ?? finalData.b64 ?? finalData.data;
    if (isString(base64) && /^[A-Za-z0-9+/=\s]+$/.test(base64) && base64.replace(/\s+/g, '').length > 100) {
      return { images: [{ url: `data:image/png;base64,${base64.replace(/\s+/g, '')}` }], videos: undefined, raw: finalData };
    }
  }

  try {
    return JSON.stringify(finalData);
  } catch {
    return finalData as NormalizedOutput;
  }
};
