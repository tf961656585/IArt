// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearIartsDataRoot, setIartsDataRoot } from './helpers/runtime-globals';

interface LocalizeRemoteMediaParams {
  projectPath: string;
  url: string;
  source?: string;
}

interface LocalizeDownloaderOptions {
  mediaDir: string;
}

interface LocalizeDownloaderResult {
  url: string;
  mediaType: string;
  mimeType: string;
  sizeBytes: number;
}

type LocalizeRemoteMediaResult =
  | { ok: true; url: string; mediaType: string; mimeType: string }
  | { ok: false; code: string };

interface RemoteLocalizeModule {
  localizeRemoteMediaToFiles: (
    params: LocalizeRemoteMediaParams,
    deps?: {
      downloader?: (url: string, options: LocalizeDownloaderOptions) => Promise<LocalizeDownloaderResult>;
    },
  ) => Promise<LocalizeRemoteMediaResult>;
}

describe('media-localization localizeRemoteMediaToFiles', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-media-localize-'));
    setIartsDataRoot(path.join(tempRoot, 'storage'));
    vi.resetModules();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    clearIartsDataRoot();
    vi.resetModules();
  });

  it('returns error when project path is invalid', async () => {
    const { localizeRemoteMediaToFiles } = await import(
      '../../apps/backend/dist/local-server/media-localization/remote-localize.cjs'
    ) as RemoteLocalizeModule;

    const result = await localizeRemoteMediaToFiles({ projectPath: '', url: 'https://example.com/a.png' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected localizeRemoteMediaToFiles to fail');
    }
    expect(result.code).toBe('missing_project_path');
  });

  it('uses downloader to resolve /files url', async () => {
    const storage = await import('../../apps/backend/dist/local-server/storage.cjs') as {
      getProjectFolderPaths: (projectPath: string) => { manifest: string; media: string } | null;
    };
    const { localizeRemoteMediaToFiles } = await import(
      '../../apps/backend/dist/local-server/media-localization/remote-localize.cjs'
    ) as RemoteLocalizeModule;

    const projectPath = path.join(tempRoot, 'demo.iartproj');
    fs.mkdirSync(projectPath, { recursive: true });
    const paths = storage.getProjectFolderPaths(projectPath);
    if (!paths?.manifest || !paths?.media) {
      throw new Error('getProjectFolderPaths failed');
    }
    fs.mkdirSync(paths.media, { recursive: true });
    fs.writeFileSync(paths.manifest, JSON.stringify({ name: '测试项目', nodeGraphId: 'graph-1' }), 'utf-8');

    const downloader = vi.fn(async (_url: string, options: LocalizeDownloaderOptions) => {
      expect(typeof options.mediaDir).toBe('string');
      expect(options.mediaDir).toBe(path.join(projectPath, 'media'));
      return {
        url: '/files/test.png',
        mediaType: 'image',
        mimeType: 'image/png',
        sizeBytes: 123,
      };
    });

    const result = await localizeRemoteMediaToFiles(
      { projectPath, url: 'https://example.com/a.png', source: 'test' },
      { downloader },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected localizeRemoteMediaToFiles to succeed');
    }
    expect(result.url).toBe('/files/test.png');
    expect(result.mediaType).toBe('image');
    expect(result.mimeType).toBe('image/png');
  });
});
