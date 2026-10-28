import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as stream from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { resolveLocalMediaUrl } from './project-media-scope.cts';

import {
  getEffectiveMaxMediaSize,
} from './config-store.cts';
import { isAllowedTaskUrl } from './network.cts';
import { logWarn } from './logging.cts';
import { writeHttpRequestRecord } from './request-record.cts';
import { getFetchDispatcher } from './fetch-dispatcher.cts';

const normalizeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

interface MediaDirOptions {
  mediaDir: string | undefined | undefined;
}

const resolveMediaDir = (options: MediaDirOptions = {} as MediaDirOptions) => {
  const raw = options.mediaDir;
  const candidate = raw && typeof raw === 'string' ? raw.trim() : '';
  if (!candidate) return null;
  try {
    fs.mkdirSync(candidate, { recursive: true });
  } catch {
    // ignore
  }
  return candidate;
};

const normalizeContentType = (value: unknown) => {
  const trimmed = normalizeString(value);
  if (!trimmed) return '';
  return (trimmed.split(';')[0] ?? '').trim().toLowerCase();
};

const stripQuotes = (value: unknown) => {
  const trimmed = normalizeString(value);
  if (!trimmed) return '';
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/aac': '.aac',
  'audio/mp4': '.m4a',
};

const guessExtension = (mimeType: unknown, urlValue: unknown, filenameHint: unknown) => {
  const normalized = normalizeContentType(mimeType);
  if (normalized && EXT_BY_MIME[normalized]) {
    return EXT_BY_MIME[normalized];
  }
  if (filenameHint) {
    const ext = path.extname(String(filenameHint)).toLowerCase();
    if (ext && ext.length <= 10) {
      return ext;
    }
  }
  if (urlValue) {
    try {
      const u = new URL(String(urlValue));
      const ext = path.extname(u.pathname || '').toLowerCase();
      if (ext && ext.length <= 10) {
        return ext;
      }
    } catch {
      // ignore
    }
  }
  return '.bin';
};

const deriveMediaTypeFromContentType = (contentType: unknown) => {
  const normalized = normalizeContentType(contentType);
  if (!normalized) return null;
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  return null;
};

const deriveMediaTypeFromUrlPath = (pathname: unknown) => {
  const lower = String(pathname || '').toLowerCase();
  if (!lower) return null;
  if (/\.(mp4|mov|webm|mkv)(\?|#|$)/i.test(lower)) return 'video';
  if (/\.(mp3|wav|m4a|aac|flac|ogg)(\?|#|$)/i.test(lower)) return 'audio';
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?|#|$)/i.test(lower)) return 'image';
  return null;
};

const toNodeReadable = (body: unknown): stream.Readable | null => {
  if (!body) return null;
  if (typeof (body as { pipe: unknown | undefined }).pipe === 'function') return body as stream.Readable;
  if (typeof stream.Readable.fromWeb === 'function') {
    try {
      return stream.Readable.fromWeb(body as Parameters<typeof stream.Readable.fromWeb>[0]);
    } catch {
      return null;
    }
  }
  return null;
};

const normalizeHeadersForFetch = (value: unknown): Record<string, string> | null => {
  if (!value || typeof value !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key) continue;
    if (raw === undefined || raw === null) continue;
    out[key] = typeof raw === 'string' ? raw : String(raw);
  }
  // 避免在 GET 下载中携带无意义/冲突的 Content-Type
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === 'content-type') {
      delete out[key];
    }
  }
  return Object.keys(out).length > 0 ? out : null;
};

interface DownloadOptions {
  source: string | undefined;
  abortSignal: AbortSignal | undefined;
  headers: Record<string, string> | undefined;
  /**
   * 查询参数形态的鉴权（`query_api_key`）。
   *
   * 只拼到本次 fetch 的地址副本上：`url` 入参、请求记录与日志保持无凭证，
   * 否则凭证会随 `writeHttpRequestRecord` 落进归档。
   */
  authQuery?: { name: string; value: string } | null;
  mediaDir: string | undefined;
  projectRef: string | undefined;
}

interface DownloadError {
  error: {
    code: string;
    message: string;
    status: number | undefined;
    contentType: string | undefined;
    sizeBytes: number | undefined;
    maxMediaSize: number | undefined;
  };
}

interface DownloadResult {
  url: string;
  fileKey: string;
  sizeBytes: number;
  mimeType: string;
  mediaType: string;
}

/**
 * 下载远程媒体并以 sha256 去重落盘到指定 mediaDir（项目 media 目录），返回 /files/ 引用。
 */
async function downloadRemoteMediaToFiles(url: unknown, options: DownloadOptions = {} as DownloadOptions): Promise<DownloadResult | DownloadError | null> {
  const source = normalizeString(options.source) || 'remote-download';
  const abortSignal = options.abortSignal;
  const requestHeaders = normalizeHeadersForFetch(options.headers);

  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let targetUrl: URL;
  try {
    targetUrl = new URL(trimmed);
  } catch {
    return { error: { code: 'invalid_url', message: 'Invalid URL', status: undefined, contentType: undefined, sizeBytes: undefined, maxMediaSize: undefined } };
  }
  if (!isAllowedTaskUrl(targetUrl)) {
    logWarn('remote media host not allowed', { url: trimmed, source });
    return { error: { code: 'remote_host_not_allowed', message: 'Remote host not allowed', status: undefined, contentType: undefined, sizeBytes: undefined, maxMediaSize: undefined } };
  }

  const maxMediaSize = getEffectiveMaxMediaSize();
  // 查询参数鉴权只进本次 fetch 的地址副本；下面所有记录/日志仍用无凭证的 trimmed。
  const authQuery = options.authQuery ?? null;
  let fetchUrl = targetUrl;
  if (authQuery !== null && authQuery.name.length > 0) {
    const authenticated = new URL(targetUrl.toString());
    authenticated.searchParams.set(authQuery.name, authQuery.value);
    fetchUrl = authenticated;
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (abortSignal) {
    try {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    } catch {
      // ignore
    }
  }

  const cleanupTimer = () => {
    if (abortSignal) {
      try {
        abortSignal.removeEventListener('abort', onAbort);
      } catch {
        // ignore
      }
    }
  };

  const mediaDir = resolveMediaDir({ mediaDir: options.mediaDir });
  if (!mediaDir) return { error: { code: 'missing_media_dir', message: 'Missing mediaDir', status: undefined, contentType: undefined, sizeBytes: undefined, maxMediaSize: undefined } };
  const tmpPath = path.join(
    mediaDir,
    `${crypto.randomUUID()}${guessExtension('', trimmed, null)}.tmp`
  );
  const requestId = `media-download-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requestLogStartMs = Date.now();

  try {
    const fetchOptions: RequestInit & { dispatcher: unknown | undefined } = {
      method: 'GET',
      ...(requestHeaders ? { headers: requestHeaders } : null),
      redirect: 'follow',
      signal: controller.signal,
      dispatcher: getFetchDispatcher(),
    };
    const resp = await fetch(fetchUrl.toString(), fetchOptions);

    try {
      const headers: Record<string, string> = {};
      resp.headers.forEach((value, key) => {
        headers[key] = value;
      });
      writeHttpRequestRecord({
        projectPath: null,
        taskId: requestId,
        attempt: 1,
        metadata: { scope: 'media-download', source, url: trimmed },
        request: { url: trimmed, method: 'GET', headers: null, body: null },
        response: {
          status: resp.status,
          ok: resp.ok,
          contentType: resp.headers.get('content-type') || '',
          headers,
          body: null,
          bodyType: null,
          file: null,
          receivedAt: new Date().toISOString(),
        },
        timing: {
          startedAt: new Date(requestLogStartMs).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - requestLogStartMs,
        },
      });
    } catch {
      // ignore
    }

    const contentTypeHeader = resp.headers.get('content-type') || '';
    const contentType = normalizeContentType(contentTypeHeader);
    const contentDispositionHeader = resp.headers.get('content-disposition') || '';
    const dispositionFilename = ((): string | null => {
      const header = normalizeString(contentDispositionHeader);
      if (!header) return null;
      const filenameStarMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
      if (filenameStarMatch) {
        const raw = stripQuotes(filenameStarMatch[1]);
        const parts = raw.split("''");
        const encoded = parts.length >= 2 ? parts.slice(1).join("''") : raw;
        try {
          const decoded = decodeURIComponent(encoded);
          const base = path.basename(decoded);
          return base && base !== '.' ? base : null;
        } catch {
          const base = path.basename(encoded);
          return base && base !== '.' ? base : null;
        }
      }
      const filenameMatch = /filename\s*=\s*([^;]+)/i.exec(header);
      if (filenameMatch) {
        const raw = stripQuotes(filenameMatch[1]);
        const base = path.basename(raw);
        return base && base !== '.' ? base : null;
      }
      return null;
    })();
    const mediaType =
      deriveMediaTypeFromContentType(contentType) ||
      deriveMediaTypeFromUrlPath(targetUrl.pathname) ||
      (dispositionFilename ? deriveMediaTypeFromUrlPath(dispositionFilename) : null);
    if (!resp.ok) {
      logWarn('remote media download failed', {
        url: trimmed,
        status: resp.status,
        contentType: contentTypeHeader,
        source,
      });
      return {
        error: {
          code: 'http_status',
          message: `HTTP ${resp.status}`,
          status: resp.status,
          contentType: contentTypeHeader,
          sizeBytes: undefined,
          maxMediaSize: undefined,
        },
      };
    }
    if (!mediaType) {
      logWarn('remote media content-type skipped', {
        url: trimmed,
        contentType: contentTypeHeader,
        source,
      });
      return {
        error: {
          code: 'content_type_skipped',
          message: 'Content-Type is not media',
          contentType: contentTypeHeader,
          status: undefined,
          sizeBytes: undefined,
          maxMediaSize: undefined,
        },
      };
    }

    const expectedSize = Number(resp.headers.get('content-length'));
    if (Number.isFinite(expectedSize) && maxMediaSize && expectedSize > maxMediaSize) {
      logWarn('remote media too large, skipped', {
        url: trimmed,
        expectedSize,
        maxMediaSize,
        source,
      });
      return {
        error: {
          code: 'media_too_large',
          message: `media too large (${expectedSize} > ${maxMediaSize})`,
          sizeBytes: expectedSize,
          maxMediaSize,
          status: undefined,
          contentType: undefined,
        },
      };
    }

    const readable = toNodeReadable(resp.body);
    if (!readable) {
      logWarn('remote media missing response body', { url: trimmed, source });
      return { error: { code: 'missing_body', message: 'Missing response body', status: undefined, contentType: undefined, sizeBytes: undefined, maxMediaSize: undefined } };
    }

    const ext = guessExtension(contentType, trimmed, dispositionFilename);
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    const limiter = new stream.Transform({
      transform(chunk: Buffer | string, _encoding: string, callback: (error: Error | null | undefined, data: Buffer | string | undefined) => void) {
        try {
          if (chunk && (chunk as Buffer).length) {
            sizeBytes += (chunk as Buffer).length;
            if (maxMediaSize && sizeBytes > maxMediaSize) {
              callback(new Error(`media too large (${sizeBytes} > ${maxMediaSize})`), undefined);
              return;
            }
            hash.update(chunk);
          }
          callback(null, chunk);
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)), undefined);
        }
      },
    });

    try {
      fs.mkdirSync(mediaDir, { recursive: true });
    } catch {
      // ignore
    }

    const out = fs.createWriteStream(tmpPath);
    await pipeline(readable, limiter, out);

    // 若存在 content-length，要求实际落盘字节数不得小于声明值（否则为截断）
    if (Number.isFinite(expectedSize) && expectedSize > 0 && sizeBytes < expectedSize) {
      logWarn('remote media incomplete, skipped', { url: trimmed, source, expectedSize, sizeBytes });
      return {
        error: {
          code: 'incomplete_download',
          message: `incomplete download (${sizeBytes}/${expectedSize})`,
          sizeBytes: expectedSize,
          maxMediaSize: sizeBytes,
          status: undefined,
          contentType: undefined,
        },
      };
    }

    const digest = hash.digest('hex');
    const filename = `${digest}${ext}`;
    const targetPath = path.join(mediaDir, filename);
    if (fs.existsSync(targetPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    } else {
      fs.renameSync(tmpPath, targetPath);
    }

    const result: DownloadResult = {
      url: (options.projectRef ? resolveLocalMediaUrl(options.projectRef, filename) : null) ?? `/files/${encodeURIComponent(filename)}`,
      fileKey: filename,
      sizeBytes,
      mimeType: contentType || 'application/octet-stream',
      mediaType,
    };
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn('remote media download error', { url: trimmed, source, error: message });
    try {
      writeHttpRequestRecord({
        projectPath: null,
        taskId: requestId,
        attempt: 1,
        metadata: { scope: 'media-download', source, url: trimmed },
        request: { url: trimmed, method: 'GET', headers: null, body: null },
        error: { message },
        timing: {
          startedAt: new Date(requestLogStartMs).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - requestLogStartMs,
        },
      });
    } catch {
      // ignore
    }
    return { error: { code: 'exception', message, status: undefined, contentType: undefined, sizeBytes: undefined, maxMediaSize: undefined } };
  } finally {
    cleanupTimer();
    try {
      if (tmpPath && fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // ignore
    }
  }
}

export {
  type DownloadResult,
  downloadRemoteMediaToFiles,
  normalizeContentType,
  deriveMediaTypeFromContentType,
};
