import {
  defaultMediaResolverRegistry,
  type ResolvedMediaItemWithMeta,
} from "@/features/models/shared/mediaResolverRegistry";
import {
  classifyMediaUrl,
  formatMediaResolutionErrorsForUser,
  getMediaSourceCapabilities,
  normalizePotentialRemoteUrl,
  type AttachmentMeta,
  type MediaResolutionError,
  type MediaResolutionErrorCode,
  type MediaResolutionTarget,
  type NormalizedMediaItemLike,
  type ResolvedMediaItemLike,
} from "@/features/models/shared/mediaResolutionTypes";

export type NormalizedMediaItem = NormalizedMediaItemLike;
export type ResolvedMediaItem = ResolvedMediaItemLike;

export interface NormalizeMediaReferencesResult {
  items: NormalizedMediaItem[];
  errors: MediaResolutionError[];
}

export type ResolvedTargetMediaReference = ResolvedMediaItemWithMeta & {
  target: MediaResolutionTarget;
};

export interface ResolveMediaReferencesResult {
  items: ResolvedTargetMediaReference[];
  errors: MediaResolutionError[];
}

export interface ResolveMediaReferenceOptions {
  maxItems: number | undefined;
}

export class MediaReferenceResolutionError extends Error {
  readonly errors: MediaResolutionError[];

  constructor(errors: MediaResolutionError[]) {
    super(formatMediaResolutionErrorsForUser(errors, undefined));
    this.name = "MediaReferenceResolutionError";
    this.errors = errors;
  }
}

/**
 * 检测值是否为 UploadFileItem-like 结构（{file, src, id}）。
 * 保留此守卫以识别 UI 层传入的 UploadFileItem 格式数据。
 */
export const isUploadFileItem = (value: unknown): value is { id: string | undefined; file: File | Blob | null | undefined; src: string | null | undefined } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return "file" in value || "src" in value || "id" in value;
};

const isRuntimeBlobLike = (value: unknown): value is Blob | File =>
  typeof Blob !== "undefined" && value instanceof Blob;

const isRuntimeFileLike = (value: unknown): value is File =>
  typeof File !== "undefined" && value instanceof File;

const emptyAttachmentMeta = (overrides: Partial<AttachmentMeta> | undefined): AttachmentMeta => ({
  id: undefined,
  sourceKind: "url",
  url: undefined,
  mimeType: undefined,
  sizeBytes: undefined,
  hash: undefined,
  base64Bytes: undefined,
  ...(overrides !== null && overrides !== undefined ? overrides : {}),
});

const createMediaResolutionError = (
  code: MediaResolutionErrorCode,
  message: string,
  item: NormalizedMediaItem | undefined,
  opts: {
    url: string | undefined;
    hint: string | undefined;
  } | undefined
): MediaResolutionError => ({
  code,
  message,
  id: (item !== null && item !== undefined ? item.id : undefined),
  url: (opts !== null && opts !== undefined ? opts.url : undefined),
  status: undefined,
  sourceKind: (item !== null && item !== undefined)
    ? item.source.type === "file" ? "file" : "url"
    : undefined,
  hint: (opts !== null && opts !== undefined ? opts.hint : undefined),
});

export const normalizeMediaReferences = (
  value: unknown,
  options: { maxItems: number | undefined } | undefined
): NormalizeMediaReferencesResult => {
  const maxItems =
    typeof (options !== null && options !== undefined ? options.maxItems : undefined) === "number" &&
    Number.isFinite((options !== null && options !== undefined ? options.maxItems : undefined) as number)
      ? Math.max(1, Math.round((options !== null && options !== undefined ? options.maxItems : undefined) as number))
      : undefined;
  const items: NormalizedMediaItem[] = [];
  const errors: MediaResolutionError[] = [];

  const processItem = (item: unknown): void => {
    if (maxItems !== undefined && items.length >= maxItems) return;

    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) {
        items.push({ id: undefined, source: { type: "url", url: trimmed } });
      }
      return;
    }

    if (isRuntimeBlobLike(item)) {
      items.push({ id: undefined, source: { type: "file", file: item } });
      return;
    }

    if (isUploadFileItem(item)) {
      const normalizedSrc = typeof item.src === "string" ? item.src.trim() : "";
      if (isRuntimeBlobLike(item.file)) {
        items.push({ id: item.id, source: { type: "file", file: item.file } });
      } else if (normalizedSrc) {
        items.push({ id: item.id, source: { type: "url", url: normalizedSrc } });
      } else if (item.file != null) {
        items.push({
          id: item.id,
          source: { type: "file", file: item.file as File | Blob },
        });
      }
      return;
    }

    if (Array.isArray(item)) {
      for (const subItem of item) {
        processItem(subItem);
      }
      return;
    }

    if (item !== undefined && item !== null) {
      errors.push({
        code: "MEDIA_INVALID_INPUT",
        message: "这份素材读不出来，请重新选择或重新上传",
        id: undefined,
        url: undefined,
        status: undefined,
        sourceKind: "url",
        hint: "请重新选择或重新上传素材",
      });
    }
  };

  processItem(value);
  return { items, errors };
};

export const normalizeMediaInput = (
  value: unknown,
  maxItems: number | undefined
): NormalizedMediaItem[] =>
  normalizeMediaReferences(value, maxItems === undefined ? undefined : { maxItems }).items;

const blobToDataUrl = async (blob: Blob): Promise<string> => {
  if (typeof FileReader !== "undefined") {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        if (!result) {
          reject(new Error("媒体数据读取失败"));
          return;
        }
        resolve(result);
      };
      reader.onerror = () => reject(new Error("媒体数据读取失败"));
      reader.readAsDataURL(blob);
    });
  }

  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 =
    typeof btoa === "function" ? btoa(binary) : "";
  if (!base64) {
    throw new Error("当前环境无法读取媒体数据");
  }
  return `data:${blob.type || "application/octet-stream"};base64,${base64}`;
};

const resolveAsBlob = async (
  item: NormalizedMediaItem
): Promise<{ item: ResolvedMediaItemWithMeta | undefined; error: MediaResolutionError | undefined }> => {
  const capabilities =
    defaultMediaResolverRegistry.getCapabilities(item) ?? getMediaSourceCapabilities(item.source);
  const rawUrl = item.source.type === "url" ? item.source.url : undefined;

  if (!capabilities.canReadBlob) {
    return {
      item: undefined,
      error: createMediaResolutionError(
        "MEDIA_UNSUPPORTED_TARGET",
        "这份素材读不出文件内容，请重新上传后再试",
        item,
        {
          url: rawUrl !== undefined ? rawUrl : undefined,
          hint: "请重新上传这份素材",
        }
      ),
    };
  }

  const resolved = await defaultMediaResolverRegistry.resolveAll([item], {
    downloadUrls: true,
  });
  const [error] = resolved.errors;
  if (error) {
    return {
      item: undefined,
      error: {
        ...error,
        message: error.message || "参考素材读取失败，请重新上传或换一个地址",
      },
    };
  }

  const resolvedItem = resolved.items[0];
  if (!(resolvedItem !== null && resolvedItem !== undefined ? resolvedItem.file : undefined) || !isRuntimeBlobLike(resolvedItem !== null && resolvedItem !== undefined ? resolvedItem.file : undefined)) {
    return {
      item: undefined,
      error: createMediaResolutionError(
        "MEDIA_UNREADABLE_SOURCE",
        "参考素材读取失败，请重新上传或换一个地址",
        item,
        {
          url: rawUrl !== undefined ? rawUrl : undefined,
          hint: "请重新上传这份素材",
        }
      ),
    };
  }

  return { item: resolvedItem, error: undefined };
};

const resolveRemoteUrl = (
  item: NormalizedMediaItem
): { item: ResolvedTargetMediaReference | undefined; error: MediaResolutionError | undefined } => {
  if (item.source.type !== "url") {
    return {
      item: undefined,
      error: createMediaResolutionError(
        "MEDIA_UNSUPPORTED_TARGET",
        "这个模型只能读网络上的素材，本地上传的素材没法直接用",
        item,
        { url: undefined, hint: "请改用支持上传素材的模型" }
      ),
    };
  }

  const classified = classifyMediaUrl(item.source.url);
  if (classified.capabilities.canUseAsRemoteUrl) {
    const meta: AttachmentMeta = emptyAttachmentMeta({
      ...(item.id ? { id: item.id } : {}),
      sourceKind: "url",
      url: classified.normalizedUrl,
    });
    return {
      item: {
        id: item.id,
        url: classified.normalizedUrl,
        file: undefined,
        mimeType: undefined,
        isObjectUrl: undefined,
        meta,
        target: "remote-url",
      },
      error: undefined,
    };
  }

  return {
    item: undefined,
    error: createMediaResolutionError(
      "MEDIA_UNSUPPORTED_TARGET",
      "这个模型只能读网络上的素材，本地或临时素材没法直接用",
      item,
      {
        url: classified.rawUrl,
        hint: "请改用支持上传素材的模型",
      }
    ),
  };
};

const resolveRenderableUrl = (
  item: NormalizedMediaItem
): { item: ResolvedTargetMediaReference | undefined; error: MediaResolutionError | undefined } => {
  if (item.source.type !== "url") {
    return {
      item: undefined,
      error: createMediaResolutionError(
        "MEDIA_UNSUPPORTED_TARGET",
        "这里需要素材的地址，不能直接用本地文件",
        item,
        { url: undefined, hint: "请先上传这份素材再试" }
      ),
    };
  }

  const classified = classifyMediaUrl(item.source.url);
  if (!classified.capabilities.canUseAsRenderableUrl) {
    return {
      item: undefined,
      error: createMediaResolutionError(
        "MEDIA_UNSUPPORTED_TARGET",
        "这个素材地址打不开，请重新上传或换一个地址",
        item,
        { url: classified.rawUrl, hint: "请重新上传或换一个素材地址" }
      ),
    };
  }

  const meta: AttachmentMeta = emptyAttachmentMeta({
    ...(item.id ? { id: item.id } : {}),
    sourceKind: "url",
    url: classified.normalizedUrl,
  });
  return {
    item: {
      id: item.id,
      url: classified.normalizedUrl,
      file: undefined,
      mimeType: undefined,
      isObjectUrl: undefined,
      meta,
      target: "renderable-url",
    },
    error: undefined,
  };
};

const withTarget = (
  item: ResolvedMediaItemWithMeta,
  target: MediaResolutionTarget
): ResolvedTargetMediaReference => ({
  ...item,
  target,
});

export const resolveMediaReference = async (
  item: NormalizedMediaItem,
  target: MediaResolutionTarget
): Promise<{ item: ResolvedTargetMediaReference | undefined; error: MediaResolutionError | undefined }> => {
  if (target === "remote-url") {
    return resolveRemoteUrl(item);
  }

  if (target === "renderable-url") {
    return resolveRenderableUrl(item);
  }

  if (target === "file-or-url") {
    if (item.source.type === "file") {
      const resolved = await resolveAsBlob(item);
      if (resolved.item) {
        return { item: withTarget(resolved.item, target), error: undefined };
      }
      return {
        item: undefined,
        error:
          resolved.error ??
          createMediaResolutionError(
            "MEDIA_UNREADABLE_SOURCE",
            "参考素材读取失败，请重新上传或换一个地址",
            item,
            undefined
          ),
      };
    }

    const classified = classifyMediaUrl(item.source.url);
    if (classified.capabilities.canUseAsRemoteUrl || classified.capabilities.canUseAsRenderableUrl) {
      const meta: AttachmentMeta = emptyAttachmentMeta({
        ...(item.id ? { id: item.id } : {}),
        sourceKind: "url",
        url: classified.normalizedUrl,
      });
      return {
        item: {
          id: item.id,
          url: classified.normalizedUrl,
          file: undefined,
          mimeType: undefined,
          isObjectUrl: undefined,
          meta,
          target,
        },
        error: undefined,
      };
    }
  }

  if (target === "base64-data-url" && item.source.type === "url") {
    const classified = classifyMediaUrl(item.source.url);
    if (classified.kind === "data") {
      const meta: AttachmentMeta = emptyAttachmentMeta({
        ...(item.id ? { id: item.id } : {}),
        sourceKind: "inline_data",
        url: classified.rawUrl,
      });
      return {
        item: {
          id: item.id,
          url: classified.rawUrl,
          file: undefined,
          mimeType: undefined,
          isObjectUrl: undefined,
          meta,
          target,
        },
        error: undefined,
      };
    }
  }

  const resolved = await resolveAsBlob(item);
  if (!resolved.item) {
    return {
      item: undefined,
      error:
        resolved.error ??
        createMediaResolutionError(
          "MEDIA_UNREADABLE_SOURCE",
          "参考素材读取失败，请重新上传或换一个地址",
          item,
          undefined
        ),
    };
  }

  if (target === "base64-data-url") {
    try {
      const dataUrl = await blobToDataUrl(resolved.item.file as Blob);
      return {
        item: {
          ...resolved.item,
          url: dataUrl,
          target,
        },
        error: undefined,
      };
    } catch {
      return {
        item: undefined,
        error: createMediaResolutionError(
          "MEDIA_UNREADABLE_SOURCE",
          "素材读取失败，请重新上传后再试",
          item,
          {
            url: resolved.item.url !== undefined ? resolved.item.url : undefined,
            hint: "请重新上传这份素材",
          }
        ),
      };
    }
  }

  return { item: withTarget(resolved.item, target), error: undefined };
};

export const resolveAllNormalizedMediaReferences = async (
  items: NormalizedMediaItem[],
  target: MediaResolutionTarget
): Promise<ResolveMediaReferencesResult> => {
  const results = await Promise.all(items.map((item) => resolveMediaReference(item, target)));
  return {
    items: results.map((result) => result.item).filter((item): item is ResolvedTargetMediaReference => Boolean(item)),
    errors: results.map((result) => result.error).filter((error): error is MediaResolutionError => Boolean(error)),
  };
};

export const resolveAllMediaReferences = async (
  value: unknown,
  target: MediaResolutionTarget,
  context: ResolveMediaReferenceOptions | undefined
): Promise<ResolveMediaReferencesResult> => {
  const normalized = normalizeMediaReferences(
    value,
    (context !== null && context !== undefined ? context.maxItems : undefined) === undefined ? undefined : { maxItems: (context as { maxItems: number }).maxItems },
  );
  if (normalized.items.length === 0) {
    return { items: [], errors: normalized.errors };
  }
  const resolved = await resolveAllNormalizedMediaReferences(normalized.items, target);
  return {
    items: resolved.items,
    errors: [...normalized.errors, ...resolved.errors],
  };
};

export const resolveFirstMediaReference = async (
  value: unknown,
  target: MediaResolutionTarget
): Promise<{ item: ResolvedTargetMediaReference | undefined; errors: MediaResolutionError[] }> => {
  const resolved = await resolveAllMediaReferences(value, target, { maxItems: 1 });
  const first = resolved.items[0];
  return {
    item: first !== undefined ? first : undefined,
    errors: resolved.errors,
  };
};

export const assertMediaReferencesResolved = (errors: MediaResolutionError[]): void => {
  if (errors.length > 0) {
    throw new MediaReferenceResolutionError(errors);
  }
};

export const normalizeRemoteUrlForMediaInput = (raw: string): string =>
  normalizePotentialRemoteUrl(raw);

export const isFileLikeMediaValue = isRuntimeFileLike;
