import { createWithEqualityFn } from 'zustand/traditional';
import { getRuntimeAppVersion } from '@/client/utils/appVersion';
import { DEFAULT_LOCALE, normalizeLocale, type AppLocale } from '@/lib/i18n/locales';
import type { EditorDesktopBootstrap } from '@iart/contracts/editor-backend-contract';

interface RuntimeState {
  appVersion: string;
  bootstrapStatus: 'idle' | 'loading' | 'ready' | 'error';
  bootstrapError: string | null;
  desktopBootstrap: EditorDesktopBootstrap | null;
  locale: AppLocale;
  backendBaseUrl: string | null;
  projectPath: string | null;
  projectRef: string | null;
  setAppVersion: (version: string) => void;
  setBootstrapLoading: () => void;
  setDesktopBootstrap: (bootstrap: EditorDesktopBootstrap) => void;
  setBootstrapError: (message: string) => void;
}

const FALLBACK_APP_VERSION = 'dev';

const getInitialAppVersion = (): string => {
  const runtime = getRuntimeAppVersion();
  return runtime ?? FALLBACK_APP_VERSION;
};

export const useRuntimeStore = createWithEqualityFn<RuntimeState>()((set) => ({
  appVersion: getInitialAppVersion(),
  bootstrapStatus: 'idle',
  bootstrapError: null,
  desktopBootstrap: null,
  locale: DEFAULT_LOCALE,
  backendBaseUrl: null,
  projectPath: null,
  projectRef: null,
  setAppVersion: (version) => set({ appVersion: version }),
  setBootstrapLoading: () => set({ bootstrapStatus: 'loading', bootstrapError: null }),
  setDesktopBootstrap: (bootstrap) =>
    set({
      bootstrapStatus: 'ready',
      bootstrapError: null,
      desktopBootstrap: bootstrap,
      locale: normalizeLocale(bootstrap.locale),
      backendBaseUrl: bootstrap.backendBaseUrl.trim(),
      projectPath: typeof bootstrap.projectPath === 'string' && bootstrap.projectPath.trim() ? bootstrap.projectPath.trim() : null,
      projectRef: typeof bootstrap.projectRef === 'string' && bootstrap.projectRef.trim() ? bootstrap.projectRef.trim() : null,
    }),
  setBootstrapError: (message) =>
    set({
      bootstrapStatus: 'error',
      bootstrapError: message.trim() || 'editor_bootstrap_failed',
      desktopBootstrap: null,
      backendBaseUrl: null,
      projectPath: null,
      projectRef: null,
    }),
}));

export const getRuntimeLocale = (): AppLocale => useRuntimeStore.getState().locale;

export const getRuntimeBackendBaseUrl = (): string | null => {
  const value = useRuntimeStore.getState().backendBaseUrl;
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof window !== 'undefined') {
    const hinted = (window as typeof window & { __IART_LOCAL_API_BASE__: unknown | undefined }).__IART_LOCAL_API_BASE__;
    if (typeof hinted === 'string' && hinted.trim()) {
      return hinted.trim();
    }
  }
  return null;
};

export const getRuntimeProjectPath = (): string | null => {
  const value = useRuntimeStore.getState().projectPath;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

export const getRuntimeProjectRef = (): string | null => {
  const value = useRuntimeStore.getState().projectRef;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

export const getRuntimeSessionToken = (): string | null => {
  const bootstrap = useRuntimeStore.getState().desktopBootstrap;
  const sessionToken = bootstrap !== null && bootstrap !== undefined ? bootstrap.sessionToken : undefined;
  return typeof sessionToken === 'string' && sessionToken.trim()
    ? sessionToken.trim()
    : null;
};
