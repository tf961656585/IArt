import { getRuntimeBackendBaseUrl } from '@/client/store/runtimeStore';

const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

export const buildCanvasTaskSocketUrl = ({ projectPath }: { projectPath: string }): string | null => {
  const backendBaseUrl = getRuntimeBackendBaseUrl();
  if (!backendBaseUrl) return null;

  try {
    const url = new URL(backendBaseUrl);
    if (!isLoopbackHost(url.hostname)) return null;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws/tasks';
    url.search = '';
    url.searchParams.set('projectPath', projectPath);
    return url.toString();
  } catch {
    return null;
  }
};
