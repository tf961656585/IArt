export const DEFAULT_VIDEO_DURATION_TIMEOUT_MS = 15000;

const normalizeUrl = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * 读取视频时长（秒）。
 * - 依赖浏览器环境的 HTMLVideoElement（Canvas/Editor 侧可用）
 * - 仅用于 metadata，不做解码/渲染
 */
export async function probeVideoDurationSeconds(
  videoUrl: string,
  options: { timeoutMs: number | undefined } | undefined
): Promise<number> {
  const url = normalizeUrl(videoUrl);
  if (!url) {
    throw new Error('缺少视频 URL');
  }
  if (typeof document === 'undefined') {
    throw new Error('当前环境不支持读取视频时长');
  }

  const timeoutMs = (options !== null && options !== undefined ? options.timeoutMs : undefined) ?? DEFAULT_VIDEO_DURATION_TIMEOUT_MS;

  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      if (video.readyState >= 1) {
        resolve();
        return;
      }
      const onLoaded = () => resolve();
      const onError = () => reject(new Error('视频加载失败'));
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      try {
        video.load();
      } catch {
        // ignore
      }
    }),
    timeoutMs,
    '读取视频时长超时'
  );

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (!duration || duration <= 0) {
    throw new Error('无法获取视频时长');
  }
  return duration;
}

