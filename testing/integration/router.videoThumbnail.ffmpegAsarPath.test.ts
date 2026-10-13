// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('backend resolveExecutablePath - ffmpeg asar path', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-router-video-thumb-ffmpeg-'));
    vi.resetModules();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('当 ffmpeg-static 返回 app.asar 路径且对应 unpacked 存在时，应返回 unpacked 路径（即便 raw 也存在）', async () => {
    const { resolveExecutablePath } = await import('../../apps/backend/dist/local-server/executable-path.cjs') as {
      resolveExecutablePath: (rawPath: unknown) => string | null;
    };

    const ffmpegRawPath = path.join(tempRoot, 'resources', 'app.asar', 'node_modules', 'ffmpeg-static', 'ffmpeg');
    const ffmpegUnpackedPath = ffmpegRawPath.replace('app.asar', 'app.asar.unpacked');
    fs.mkdirSync(path.dirname(ffmpegRawPath), { recursive: true });
    fs.mkdirSync(path.dirname(ffmpegUnpackedPath), { recursive: true });
    fs.writeFileSync(ffmpegRawPath, '');
    fs.writeFileSync(ffmpegUnpackedPath, '');
    expect(resolveExecutablePath(ffmpegRawPath)).toBe(ffmpegUnpackedPath);
  });

  it('当 ffmpeg-static 返回 app.asar 路径但 unpacked 不存在时，应返回 null（避免 spawn 执行 asar 内路径）', async () => {
    const { resolveExecutablePath } = await import('../../apps/backend/dist/local-server/executable-path.cjs') as {
      resolveExecutablePath: (rawPath: unknown) => string | null;
    };

    const ffmpegRawPath = path.join(tempRoot, 'resources', 'app.asar', 'node_modules', 'ffmpeg-static', 'ffmpeg');
    fs.mkdirSync(path.dirname(ffmpegRawPath), { recursive: true });
    fs.writeFileSync(ffmpegRawPath, '');
    expect(resolveExecutablePath(ffmpegRawPath)).toBeNull();
  });
});
