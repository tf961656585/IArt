import { fetchBlobWithHub } from "@/client/utils/hubFetch";
import {
  computeBlobSha256,
  getMediaSourceCapabilities,
  type AttachmentMeta,
  type MediaSourceCapabilities,
  type MediaResolutionError,
  type NormalizedMediaItemLike,
  type ResolvedMediaItemLike,
} from "@/features/models/shared/mediaResolutionTypes";

export interface MediaResolverContext {
  downloadUrls: boolean;
}

export type ResolvedMediaItemWithMeta = ResolvedMediaItemLike & { meta: AttachmentMeta };

export interface ResolveOneResult {
  item: ResolvedMediaItemWithMeta;
  error: MediaResolutionError | undefined;
}

export interface MediaInputResolver {
  id: string;
  match: (item: NormalizedMediaItemLike) => boolean;
  getCapabilities: ((item: NormalizedMediaItemLike) => MediaSourceCapabilities) | undefined;
  resolve: (item: NormalizedMediaItemLike, ctx: MediaResolverContext) => Promise<ResolveOneResult>;
}

export class MediaResolverRegistry {
  private readonly resolvers: MediaInputResolver[];

  constructor(resolvers: MediaInputResolver[]) {
    this.resolvers = [...resolvers];
  }

  register(resolver: MediaInputResolver): void {
    const id = resolver.id.trim();
    if (!id) return;
    const existing = this.resolvers.findIndex((r) => r.id === id);
    if (existing >= 0) {
      this.resolvers.splice(existing, 1, resolver);
      return;
    }
    this.resolvers.push(resolver);
  }

  async resolveAll(
    items: NormalizedMediaItemLike[],
    ctx: MediaResolverContext
  ): Promise<{ items: ResolvedMediaItemWithMeta[]; errors: MediaResolutionError[] }> {
    const results = await Promise.all(items.map((it) => this.resolveOne(it, ctx)));
    const outItems = results.map((r) => r.item);
    const errors = results.map((r) => r.error).filter((e): e is MediaResolutionError => Boolean(e));
    return { items: outItems, errors };
  }

  getCapabilities(item: NormalizedMediaItemLike): MediaSourceCapabilities | null {
    const resolver = this.findResolver(item);
    if (!resolver) return null;
    if (resolver.getCapabilities !== undefined) {
      return resolver.getCapabilities(item);
    }
    return getMediaSourceCapabilities(item.source);
  }

  private async resolveOne(item: NormalizedMediaItemLike, ctx: MediaResolverContext): Promise<ResolveOneResult> {
    const resolver = this.findResolver(item);

    if (!resolver) {
      const meta: AttachmentMeta = {
        id: item.id,
        sourceKind: item.source.type === "file" ? "file" : "url",
        url: item.source.type === "url" ? item.source.url : undefined,
        mimeType: undefined,
        sizeBytes: undefined,
        hash: undefined,
        base64Bytes: undefined,
      };
      return {
        item: {
          id: item.id,
          file: undefined,
          url: undefined,
          mimeType: undefined,
          isObjectUrl: undefined,
          meta,
        },
        error: {
          code: "MEDIA_UNSUPPORTED_SOURCE",
          message: "这种素材暂时读不了，请重新选择或重新上传",
          id: item.id,
          url: meta.url,
          sourceKind: meta.sourceKind,
          hint: "请重新选择或重新上传素材",
          status: undefined,
        },
      };
    }

    return resolver.resolve(item, ctx);
  }

  private findResolver(item: NormalizedMediaItemLike): MediaInputResolver | undefined {
    return this.resolvers.find((r) => {
      try {
        return r.match(item);
      } catch {
        return false;
      }
    });
  }
}

const classifyFetchError = (err: unknown, url: string): MediaResolutionError => {
  const trimmedUrl = typeof url === 'string' ? url.trim() : '';
  if (trimmedUrl.toLowerCase().startsWith('blob:')) {
    return {
      code: 'MEDIA_SESSION_URL_INVALID',
      message: '这张图片已经失效，请重新上传',
      url: trimmedUrl,
      sourceKind: 'url',
      hint: '请重新上传后再试',
      id: undefined,
      status: undefined,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";

  if (name === "AbortError") {
    return {
      code: "MEDIA_URL_TIMEOUT",
      message: "素材下载超时，请检查网络后重试",
      url,
      sourceKind: "url",
      hint: "请检查网络，或改为重新上传本地文件",
      id: undefined,
      status: undefined,
    };
  }

  const http = message.match(/^HTTP\s+(\d{3})/i);
  if (http) {
    const status = Number(http[1]);
    return {
      code: "MEDIA_URL_HTTP_ERROR",
      message: "素材下载失败，请检查网络后重试",
      url,
      status,
      sourceKind: "url",
      hint: "请检查这个链接能否打开，或改为重新上传本地文件",
      id: undefined,
    };
  }

  if (!url.trim()) {
    return {
      code: "MEDIA_URL_INVALID",
      message: "素材链接无效，请重新填写",
      url,
      sourceKind: "url",
      hint: "请重新选择或重新上传素材",
      id: undefined,
      status: undefined,
    };
  }

  return {
    code: "MEDIA_URL_NETWORK_ERROR",
    message: "素材下载失败，请检查网络后重试",
    url,
    sourceKind: "url",
    hint: "请检查网络，或改为重新上传本地文件",
    id: undefined,
    status: undefined,
  };
};

const fileResolver: MediaInputResolver = {
  id: "file",
  match: (item) => item.source.type === "file",
  getCapabilities: (item) => getMediaSourceCapabilities(item.source),
  resolve: async (item) => {
    const file = item.source.type === "file" ? item.source.file : undefined;
    const mimeType = file !== undefined ? file.type : undefined;
    const sizeBytes = file !== undefined ? file.size : undefined;
    const meta: AttachmentMeta = {
      id: item.id,
      sourceKind: "file",
      url: undefined,
      mimeType: mimeType || undefined,
      sizeBytes,
      hash: file ? await computeBlobSha256(file) : undefined,
      base64Bytes: undefined,
    };
    return {
      item: {
        id: item.id,
        file,
        url: undefined,
        mimeType: mimeType || undefined,
        isObjectUrl: undefined,
        meta,
      },
      error: undefined,
    };
  },
};

const urlResolver: MediaInputResolver = {
  id: "url",
  match: (item) => item.source.type === "url",
  getCapabilities: (item) => getMediaSourceCapabilities(item.source),
  resolve: async (item, ctx) => {
    const url = item.source.type === "url" ? item.source.url : "";
    const meta: AttachmentMeta = {
      id: item.id,
      sourceKind: "url",
      url,
      mimeType: undefined,
      sizeBytes: undefined,
      hash: undefined,
      base64Bytes: undefined,
    };

    if (!ctx.downloadUrls) {
      return {
        item: {
          id: item.id,
          file: undefined,
          url,
          mimeType: undefined,
          isObjectUrl: undefined,
          meta,
        },
        error: undefined,
      };
    }

    try {
      const { blob, mimeType } = await fetchBlobWithHub(url);
      const metaWithBlob: AttachmentMeta = {
        ...meta,
        mimeType: mimeType || blob.type || undefined,
        sizeBytes: blob.size,
        hash: await computeBlobSha256(blob),
      };
      return {
        item: {
          id: item.id,
          url,
          file: blob,
          mimeType: mimeType || blob.type || undefined,
          isObjectUrl: undefined,
          meta: metaWithBlob,
        },
        error: undefined,
      };
    } catch (err) {
      return {
        item: {
          id: item.id,
          file: undefined,
          url,
          mimeType: undefined,
          isObjectUrl: undefined,
          meta,
        },
        error: { ...classifyFetchError(err, url), id: item.id },
      };
    }
  },
};

export const defaultMediaResolverRegistry = new MediaResolverRegistry([fileResolver, urlResolver]);
