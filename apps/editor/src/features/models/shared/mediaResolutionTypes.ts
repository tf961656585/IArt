export type MediaInputSourceKind = "file" | "url" | "inline_data";

export type MediaResolutionTarget =
  | "upload-file"
  | "remote-url"
  | "base64-data-url"
  | "renderable-url"
  | "file-or-url";

export type MediaResolutionErrorCode =
  | "MEDIA_EMPTY_INPUT"
  | "MEDIA_INVALID_INPUT"
  | "MEDIA_URL_HTTP_ERROR"
  | "MEDIA_URL_TIMEOUT"
  | "MEDIA_URL_NETWORK_ERROR"
  | "MEDIA_SESSION_URL_INVALID"
  | "MEDIA_URL_INVALID"
  | "MEDIA_UNSUPPORTED_SOURCE"
  | "MEDIA_UNREADABLE_SOURCE"
  | "MEDIA_UNSUPPORTED_TARGET"
  | "MEDIA_MISSING_PROJECT_CONTEXT";

export type AttachmentHash = {
  algo: "sha256";
  hex: string;
  bytesHashed: number;
};

export type AttachmentMeta = {
  id: string | undefined;
  sourceKind: MediaInputSourceKind;
  url: string | undefined;
  mimeType: string | undefined;
  sizeBytes: number | undefined;
  hash: AttachmentHash | undefined;
  base64Bytes: number | undefined;
};

export type MediaResolutionError = {
  code: MediaResolutionErrorCode;
  message: string;
  id: string | undefined;
  url: string | undefined;
  status: number | undefined;
  sourceKind: MediaInputSourceKind | undefined;
  hint: string | undefined;
};

export type NormalizedMediaSource =
  | { type: "file"; file: File | Blob }
  | { type: "url"; url: string };

export type NormalizedMediaItemLike = {
  id: string | undefined;
  source: NormalizedMediaSource;
};

export type ResolvedMediaItemLike = {
  id: string | undefined;
  file: File | Blob | undefined;
  url: string | undefined;
  mimeType: string | undefined;
  isObjectUrl: boolean | undefined;
};

export type MediaSourceCapabilities = {
  canReadBlob: boolean;
  canUseAsRemoteUrl: boolean;
  canUseAsRenderableUrl: boolean;
  canRevealFile: boolean;
  isProjectScoped: boolean | undefined;
  isVolatile: boolean | undefined;
  requiresHubRuntime: boolean | undefined;
};

export type MediaUrlKind =
  | "empty"
  | "data"
  | "blob"
  | "file"
  | "local-media"
  | "remote-http"
  | "local-http"
  | "relative"
  | "unknown";

export type ClassifiedMediaUrl = {
  rawUrl: string;
  normalizedUrl: string;
  kind: MediaUrlKind;
  fileKey: string | null;
  capabilities: MediaSourceCapabilities;
};

const DEFAULT_UNREADABLE_CAPABILITIES: MediaSourceCapabilities = {
  canReadBlob: false,
  canUseAsRemoteUrl: false,
  canUseAsRenderableUrl: false,
  canRevealFile: false,
  isProjectScoped: undefined,
  isVolatile: undefined,
  requiresHubRuntime: undefined,
};

import mediaConstantsModule from "@iart/utils/media-constants";
const { LOCAL_MEDIA_SCHEME } = mediaConstantsModule;

import mediaFileKeyModule from "@iart/utils/media-file-key";
const { extractMediaFileKey, isLocalMediaScope } = mediaFileKeyModule;

export const isHttpUrlLike = (value: string): boolean => /^https?:\/\//i.test(value);

const looksLikeDomain = (raw: string): boolean =>
  /^[a-z0-9.-]+\.[a-z]{2,}([/:?#]|$)/i.test(raw.trim());

const extractLocalMediaPathAfterScheme = (url: string): string => {
  return url.slice(LOCAL_MEDIA_SCHEME.length);
};

export const normalizePotentialRemoteUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (looksLikeDomain(trimmed)) return `https://${trimmed}`;
  return trimmed;
};

const isLoopbackHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
};

export const classifyMediaUrl = (raw: string): ClassifiedMediaUrl => {
  const rawUrl = typeof raw === "string" ? raw.trim() : "";
  if (!rawUrl) {
    return {
      rawUrl,
      normalizedUrl: rawUrl,
      kind: "empty",
      fileKey: null,
      capabilities: DEFAULT_UNREADABLE_CAPABILITIES,
    };
  }

  const lower = rawUrl.toLowerCase();
  if (lower.startsWith("data:")) {
    return {
      rawUrl,
      normalizedUrl: rawUrl,
      kind: "data",
      fileKey: null,
      capabilities: {
        canReadBlob: true,
        canUseAsRemoteUrl: false,
        canUseAsRenderableUrl: true,
        canRevealFile: false,
        isProjectScoped: undefined,
        isVolatile: undefined,
        requiresHubRuntime: undefined,
      },
    };
  }

  if (lower.startsWith("blob:")) {
    return {
      rawUrl,
      normalizedUrl: rawUrl,
      kind: "blob",
      fileKey: null,
      capabilities: {
        canReadBlob: true,
        canUseAsRemoteUrl: false,
        canUseAsRenderableUrl: true,
        canRevealFile: false,
        isProjectScoped: undefined,
        isVolatile: true,
        requiresHubRuntime: undefined,
      },
    };
  }

  if (lower.startsWith("file:")) {
    return {
      rawUrl,
      normalizedUrl: rawUrl,
      kind: "file",
      fileKey: null,
      capabilities: {
        canReadBlob: true,
        canUseAsRemoteUrl: false,
        canUseAsRenderableUrl: true,
        canRevealFile: false,
        isProjectScoped: undefined,
        isVolatile: undefined,
        requiresHubRuntime: true,
      },
    };
  }

  if (lower.startsWith(LOCAL_MEDIA_SCHEME)) {
    const pathAfterScheme = extractLocalMediaPathAfterScheme(rawUrl);
    const slashIndex = pathAfterScheme.indexOf('/');
    // New format: local-media://{projectRef}/{fileKey}
    if (slashIndex >= 0) {
      const firstSegment = pathAfterScheme.slice(0, slashIndex);
      if (isLocalMediaScope(firstSegment)) {
        const fileKey = extractMediaFileKey(rawUrl);
        return {
          rawUrl,
          normalizedUrl: rawUrl,
          kind: "local-media",
          fileKey,
          capabilities: {
            canReadBlob: true,
            canUseAsRemoteUrl: false,
            canUseAsRenderableUrl: true,
            canRevealFile: true,
            isProjectScoped: true,
            isVolatile: undefined,
            requiresHubRuntime: undefined,
          },
        };
      }
    }
    // Legacy format: local-media://{fileKey}
    const fileKey = extractMediaFileKey(rawUrl);
    return {
      rawUrl,
      normalizedUrl: rawUrl,
      kind: "local-media",
      fileKey,
      capabilities: {
        canReadBlob: true,
        canUseAsRemoteUrl: false,
        canUseAsRenderableUrl: true,
        canRevealFile: true,
        isProjectScoped: true,
        isVolatile: undefined,
        requiresHubRuntime: undefined,
      },
    };
  }

  if (rawUrl.startsWith("/")) {
    return {
      rawUrl,
      normalizedUrl: rawUrl,
      kind: "relative",
      fileKey: null,
      capabilities: {
        canReadBlob: true,
        canUseAsRemoteUrl: false,
        canUseAsRenderableUrl: true,
        canRevealFile: false,
        isProjectScoped: undefined,
        isVolatile: undefined,
        requiresHubRuntime: true,
      },
    };
  }

  const normalizedUrl = normalizePotentialRemoteUrl(rawUrl);
  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const local = isLoopbackHost(parsed.hostname);
      return {
        rawUrl,
        normalizedUrl,
        kind: local ? "local-http" : "remote-http",
        fileKey: null,
        capabilities: {
          canReadBlob: true,
          canUseAsRemoteUrl: !local,
          canUseAsRenderableUrl: true,
          canRevealFile: false,
          isProjectScoped: undefined,
          isVolatile: undefined,
          requiresHubRuntime: local ? true : undefined,
        },
      };
    }
  } catch {
    // Fall through to unknown.
  }

  return {
    rawUrl,
    normalizedUrl: rawUrl,
    kind: "unknown",
    fileKey: null,
    capabilities: DEFAULT_UNREADABLE_CAPABILITIES,
  };
};

export const getMediaSourceCapabilities = (
  source: NormalizedMediaSource
): MediaSourceCapabilities => {
  if (source.type === "file") {
    return {
      canReadBlob: true,
      canUseAsRemoteUrl: false,
      canUseAsRenderableUrl: false,
      canRevealFile: false,
      isProjectScoped: undefined,
      isVolatile: undefined,
      requiresHubRuntime: undefined,
    };
  }
  return classifyMediaUrl(source.url).capabilities;
};

const bytesToHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
};

const digestSha256Hex = async (bytes: ArrayBuffer): Promise<string | undefined> => {
  const crypto = globalThis.crypto;
  const subtle = crypto !== null && crypto !== undefined ? crypto.subtle : undefined;
  if (subtle === null || subtle === undefined || subtle.digest === undefined) return undefined;
  try {
    const hashBuf = await subtle.digest("SHA-256", bytes);
    return bytesToHex(new Uint8Array(hashBuf));
  } catch {
    return undefined;
  }
};

export const computeBlobSha256 = async (
  blob: Blob,
  opts: { maxBytes: number | undefined } | undefined = undefined
): Promise<AttachmentHash | undefined> => {
  const rawMaxBytes = opts !== undefined ? opts.maxBytes : undefined;
  const maxBytes = rawMaxBytes !== undefined && Number.isFinite(rawMaxBytes) ? Math.max(1, Math.round(rawMaxBytes)) : 128 * 1024;
  const bytesHashed = Math.min(blob.size, maxBytes);
  try {
    const buf = await blob.slice(0, bytesHashed).arrayBuffer();
    const hex = await digestSha256Hex(buf);
    return hex ? { algo: "sha256", hex, bytesHashed } : undefined;
  } catch {
    return undefined;
  }
};

export const formatMediaResolutionErrorsForUser = (
  errors: MediaResolutionError[],
  opts: { maxItems: number | undefined } | undefined = undefined
): string => {
  const rawMaxItems = opts !== undefined ? opts.maxItems : undefined;
  const maxItems = rawMaxItems !== undefined && Number.isFinite(rawMaxItems) ? Math.max(1, Math.round(rawMaxItems)) : 3;
  const head = errors.slice(0, maxItems);
  const [first] = head;
  if (!first) return '素材读取失败，请重新上传后再试。';
  const messages = head.map((e) => e.message);
  const hint = first.hint !== undefined && first.hint !== '' ? `（${first.hint}）` : '';
  const more = errors.length > head.length ? `，另有 ${errors.length - head.length} 个素材有同样问题` : '';
  return `${messages.join('；')}${hint}${more}`;
};
