import { getProjectFolderPaths, isValidProjectFolder } from '../storage.cts';
import { downloadRemoteMediaToFiles } from '../media-download.cts';
import {
  EDITOR_BACKEND_MEDIA_CONTRACT,
  buildEditorLocalizedMediaDescriptor,
} from '../contracts.cts';
import { resolveProjectRefByPath } from '../project-media-scope.cts';

interface LocalizeRemoteMediaParams {
  projectPath: unknown | undefined;
  url: unknown | undefined;
  source: unknown | undefined;
  mediaType: unknown | undefined;
  mimeType: unknown | undefined;
}

interface LocalizeRemoteMediaDeps {
  downloader: RemoteMediaDownloader | undefined;
}

interface RemoteMediaDownloadOptions {
  mediaDir: string;
  source: string;
  projectRef: string | undefined;
}

interface RemoteMediaDownloadError {
  error: {
    code: unknown | undefined;
    message: unknown | undefined;
  };
}

interface RemoteMediaDownloadResult {
  url: unknown | undefined;
  mediaType: unknown | undefined;
  mimeType: unknown | undefined;
  sizeBytes: unknown | undefined;
}

type RemoteMediaStored = RemoteMediaDownloadResult | RemoteMediaDownloadError | null;

type RemoteMediaDownloader = (
  url: string,
  options: RemoteMediaDownloadOptions,
) => Promise<RemoteMediaStored>;

const DEFAULT_LOCALIZE_REMOTE_MEDIA_PARAMS: LocalizeRemoteMediaParams = {
  projectPath: undefined,
  url: undefined,
  source: undefined,
  mediaType: undefined,
  mimeType: undefined,
};

const DEFAULT_LOCALIZE_REMOTE_MEDIA_DEPS: LocalizeRemoteMediaDeps = {
  downloader: undefined,
};

const isDownloadError = (value: RemoteMediaStored): value is RemoteMediaDownloadError =>
  Boolean(value && typeof value === 'object' && 'error' in value);

const normalizeString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const isHttpUrl = (value: unknown): boolean => /^https?:\/\//i.test(normalizeString(value));

const localizeRemoteMediaToFiles = async (
  params: LocalizeRemoteMediaParams = DEFAULT_LOCALIZE_REMOTE_MEDIA_PARAMS,
  deps: LocalizeRemoteMediaDeps = DEFAULT_LOCALIZE_REMOTE_MEDIA_DEPS,
) => {
  const projectPath = normalizeString(params.projectPath);
  if (!projectPath) {
    return { ok: false, code: 'missing_project_path', message: '缺少项目路径' };
  }
  if (!isValidProjectFolder(projectPath)) {
    return { ok: false, code: 'invalid_project_path', message: '项目路径无效' };
  }

  const url = normalizeString(params.url);
  if (!isHttpUrl(url)) {
    return { ok: false, code: 'invalid_url', message: '无效的媒体地址' };
  }

  const folderPaths = getProjectFolderPaths(projectPath);
  const mediaDir = (folderPaths !== null && folderPaths !== undefined ? folderPaths.media : undefined);
  if (!mediaDir) {
    return { ok: false, code: 'missing_media_dir', message: '项目媒体目录不可用' };
  }

  const downloader = deps.downloader || downloadRemoteMediaToFiles;
  const projectRefValue = resolveProjectRefByPath(projectPath) ?? undefined;
  const stored = await downloader(url, {
    mediaDir,
      abortSignal: undefined, headers: undefined,
    source: normalizeString(params.source) || 'api:media-localize',
    projectRef: projectRefValue,
  });

  if (!stored) {
    return { ok: false, code: 'download_failed', message: '远程媒体下载失败' };
  }

  if (isDownloadError(stored)) {
    return {
      ok: false,
      code: normalizeString(stored.error.code) || 'download_failed',
      message: normalizeString(stored.error.message) || '远程媒体下载失败',
    };
  }

  const finalUrl = normalizeString(stored.url);
  if (!finalUrl) {
    return { ok: false, code: 'download_failed', message: '远程媒体下载失败' };
  }

  return {
    ok: true,
    ...buildEditorLocalizedMediaDescriptor({
      url: finalUrl,
      originalUrl: url,
      mediaType: normalizeString(stored.mediaType) || null,
      mimeType: normalizeString(stored.mimeType) || null,
      sizeBytes: Number.isFinite(stored.sizeBytes) ? stored.sizeBytes : null,
    }),
    contract: {
      owner: EDITOR_BACKEND_MEDIA_CONTRACT.owner,
      localizedUrlPrefix: EDITOR_BACKEND_MEDIA_CONTRACT.localizedUrlPrefix,
      displayRequiresLocalizedFile: EDITOR_BACKEND_MEDIA_CONTRACT.displayRequiresLocalizedFile,
    },
  };
};

export {
  localizeRemoteMediaToFiles,
};
