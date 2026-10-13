import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { cast } from '@/lib/utils';

import {
  resolveHubFetchTarget,
  resolveStrictHubFetchTarget,
} from '@/client/utils/hubFetchTargetResolver';

interface WindowWithTestProps {
  __IART_LOCAL_API_BASE__: string;
  electron: unknown;
}

const win = () => cast<WindowWithTestProps>(window);

describe('resolveHubFetchTarget', () => {
  const originalLocalBase: string | undefined = cast<WindowWithTestProps>(window).__IART_LOCAL_API_BASE__;
  const originalElectron: unknown = cast<WindowWithTestProps>(window).electron;

  const clearLocalBase = () => Reflect.deleteProperty(window, '__IART_LOCAL_API_BASE__');
  const clearElectron = () => Reflect.deleteProperty(window, 'electron');

  const restoreLocalBase = () => {
    if (originalLocalBase !== undefined) {
      win().__IART_LOCAL_API_BASE__ = originalLocalBase;
    } else {
      clearLocalBase();
    }
  };
  const restoreElectron = () => {
    if (originalElectron !== undefined) {
      win().electron = originalElectron;
    } else {
      clearElectron();
    }
  };

  beforeEach(() => {
    const storageState = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        get length() {
          return storageState.size;
        },
        key: (index: number) => Array.from(storageState.keys())[index] ?? null,
        getItem: (key: string) => storageState.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storageState.set(key, String(value));
        },
        removeItem: (key: string) => {
          storageState.delete(key);
        },
        clear: () => {
          storageState.clear();
        },
      } satisfies Storage,
    });
  });

  afterEach(() => {
    restoreLocalBase();
    restoreElectron();
  });

  it('resolves /files/... to local hub base in hub runtime', () => {
    win().__IART_LOCAL_API_BASE__ = 'http://localhost:4000';
    const resolved = resolveHubFetchTarget('/files/a.png?t=1', { format: 'blob' });
    expect(resolved).toBe('http://localhost:4000/files/a.png?t=1');
  });

  it('proxies remote http(s) via /api/media-proxy in hub runtime', () => {
    win().__IART_LOCAL_API_BASE__ = 'http://localhost:4000';
    const resolved = resolveHubFetchTarget('https://example.com/a.png', { format: 'blob' });
    expect(resolved).toBe(
      `http://localhost:4000/api/media-proxy?url=${encodeURIComponent('https://example.com/a.png')}&format=blob`
    );
  });

  it('returns raw url in non-hub runtime', () => {
    clearLocalBase();
    clearElectron();
    const resolved = resolveHubFetchTarget('/files/a.png?t=1', { format: 'blob' });
    expect(resolved).toBe('/files/a.png?t=1');
  });

  it('strict resolver: non-hub runtime remote http(s) fail-close', () => {
    clearLocalBase();
    clearElectron();
    const resolved = resolveStrictHubFetchTarget('https://example.com/a.png', {
      format: 'blob',
    });
    expect(resolved).toBeNull();
  });

  it('strict resolver: hub runtime remote http(s) stays on media-proxy path', () => {
    win().__IART_LOCAL_API_BASE__ = 'http://localhost:4000';
    const resolved = resolveStrictHubFetchTarget('https://example.com/a.png', {
      format: 'blob',
    });
    expect(resolved).toBe(
      `http://localhost:4000/api/media-proxy?url=${encodeURIComponent('https://example.com/a.png')}&format=blob`
    );
  });

  it('本地运行态拿不到本地基座时，不会把 /files 误拼到远端默认地址', () => {
    clearLocalBase();
    win().electron = {};
    const resolved = resolveHubFetchTarget('/files/a.png?t=1', { format: 'blob' });
    expect(resolved).toBe('/files/a.png?t=1');
  });

  it('本地运行态拿不到本地基座时，不会把 media-proxy 误拼到远端默认地址', () => {
    clearLocalBase();
    win().electron = {};
    const resolved = resolveStrictHubFetchTarget('https://example.com/a.png', {
      format: 'blob',
    });
    expect(resolved).toBeNull();
  });
});
