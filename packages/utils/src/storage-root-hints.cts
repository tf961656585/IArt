import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectEnv } from './env-types.cts';

type StorageRootHintOptions = {
  env: ProjectEnv | undefined;
  globalObject: {
    __IARTS_DATA_ROOT: unknown | undefined;
  } | null | undefined;
  platform: NodeJS.Platform | undefined;
  homeDir: string | undefined;
  execPath: string | undefined;
  moduleDir: string | undefined;
  devFallbackRoot: string | undefined;
  isElectronRuntime: boolean | undefined;
};

const normalizePathFromEnv = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
};

const resolveEnvStorageRoot = (env: ProjectEnv | undefined): string =>
  normalizePathFromEnv((env !== null && env !== undefined ? env.IART_STORAGE_ROOT : undefined)) ||
  normalizePathFromEnv((env !== null && env !== undefined ? env.IART_DATA_ROOT : undefined)) ||
  normalizePathFromEnv((env !== null && env !== undefined ? env.IARTS_DATA_ROOT : undefined)) ||
  '';

const resolveInjectedDataRoot = (globalObject: unknown | undefined): string => {
  if (!globalObject || typeof globalObject !== 'object') return '';
  const injected = (globalObject as { readonly __IARTS_DATA_ROOT: unknown | undefined }).__IARTS_DATA_ROOT;
  return typeof injected === 'string' && injected.trim() ? injected.trim() : '';
};

const resolveUserStorageRoot = ({ platform, env, homeDir }: { platform: NodeJS.Platform | undefined; env: ProjectEnv | undefined; homeDir: string | undefined }): string => {
  if (platform === 'win32') {
    const base =
      (env !== null && env !== undefined ? env.LOCALAPPDATA : undefined) ||
      (env !== null && env !== undefined ? env.APPDATA : undefined) ||
      (homeDir ? path.join(homeDir, 'AppData', 'Local') : '');
    if (base) {
      return path.join(base, 'IARTStudio', 'IARTStudio_PC');
    }
  } else if (platform === 'darwin') {
    const base = homeDir ? path.join(homeDir, 'Library', 'Application Support') : '';
    if (base) {
      return path.join(base, 'IARTStudio', 'IARTStudio_PC');
    }
  } else {
    const base = (env !== null && env !== undefined ? env.XDG_DATA_HOME : undefined) || (homeDir ? path.join(homeDir, '.local', 'share') : '');
    if (base) {
      return path.join(base, 'IARTStudio', 'IARTStudio_PC');
    }
  }

  return '';
};

const canWriteDir = (dirPath: string): boolean => {
  if (!dirPath) return false;
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const readProcessEnv = (): ProjectEnv => ({
  NODE_ENV: process.env['NODE_ENV'],
  IART_STORAGE_ROOT: process.env['IART_STORAGE_ROOT'],
  IART_DATA_ROOT: process.env['IART_DATA_ROOT'],
  IARTS_DATA_ROOT: process.env['IARTS_DATA_ROOT'],
  LOCALAPPDATA: process.env['LOCALAPPDATA'],
  APPDATA: process.env['APPDATA'],
  XDG_DATA_HOME: process.env['XDG_DATA_HOME'],
  IART_BACKEND_PORT: process.env['IART_BACKEND_PORT'],
  IART_BACKEND_BASE_URL: process.env['IART_BACKEND_BASE_URL'],
  IART_APP_VERSION: process.env['IART_APP_VERSION'],
  IART_SOFTWARE_VERSION: process.env['IART_SOFTWARE_VERSION'],
  npm_package_version: process.env['npm_package_version'],
  IART_DEV_EDITOR_URL: process.env['IART_DEV_EDITOR_URL'],
  IART_EDITOR_STATIC_DIR: process.env['IART_EDITOR_STATIC_DIR'],
  IART_HUB_DEV_URL: process.env['IART_HUB_DEV_URL'],
  IART_HUB_STATIC_DIR: process.env['IART_HUB_STATIC_DIR'],
  IART_SQLITE_RUNTIME: process.env['IART_SQLITE_RUNTIME'],
  IART_MODEL_ASSET_PACKAGES_DIR: process.env['IART_MODEL_ASSET_PACKAGES_DIR'],
  IART_LOG_LEVEL: process.env['IART_LOG_LEVEL'],
  IART_MAX_UPLOAD: process.env['IART_MAX_UPLOAD'],
  IART_MAX_MEDIA: process.env['IART_MAX_MEDIA'],
  IART_MAX_BATCH_TASKS: process.env['IART_MAX_BATCH_TASKS'],
  IART_MEDIA_TIMEOUT: process.env['IART_MEDIA_TIMEOUT'],
  IART_ENV_FILE: process.env['IART_ENV_FILE'],
  IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT:
    process.env['IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT'],
  IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT:
    process.env['IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT'],
  IART_E2E_REPORT_PATH: process.env['IART_E2E_REPORT_PATH'],
  IART_E2E_AUTO_EXIT: process.env['IART_E2E_AUTO_EXIT'],
  IART_E2E_TIMEOUT_MS: process.env['IART_E2E_TIMEOUT_MS'],
  IART_E2E_OPEN_EDITOR_PROJECT_PATH:
    process.env['IART_E2E_OPEN_EDITOR_PROJECT_PATH'],
  IART_DEVTOOLS: process.env['IART_DEVTOOLS'],
  IART_DESKTOP_EXPORT: process.env['IART_DESKTOP_EXPORT'],
  VITEST: process.env['VITEST'],
});

const resolveDefaultStorageRoot = (options: StorageRootHintOptions = {} as StorageRootHintOptions): string => {
  const env: ProjectEnv = options.env ?? readProcessEnv();
  const globalObject = options.globalObject ?? globalThis;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? (typeof os.homedir === 'function' ? os.homedir() : '');
  const execPath = options.execPath ?? process.execPath;
  const moduleDir = options.moduleDir ?? __dirname;
  const devFallbackRoot = options.devFallbackRoot ?? path.resolve(moduleDir, '..', '..');
  const isElectronRuntime =
    typeof options.isElectronRuntime === 'boolean'
      ? options.isElectronRuntime
      : Boolean(process.versions['electron']);

  const envRoot = resolveEnvStorageRoot(env);
  if (envRoot) return envRoot;

  const injectedRoot = resolveInjectedDataRoot(globalObject);
  if (injectedRoot) return injectedRoot;

  if (isElectronRuntime) {
    const installDir = path.dirname(execPath);
    const legacyRoot = path.join(installDir, 'IARTStudio_PC');
    try {
      if (fs.existsSync(legacyRoot) && canWriteDir(legacyRoot)) {
        return legacyRoot;
      }
    } catch {
      // ignore
    }

    const userRoot = resolveUserStorageRoot({ platform, env, homeDir });
    if (userRoot) return userRoot;
  }

  return path.join(path.resolve(devFallbackRoot), '.iarts-data');
};

const resolveBackendLogPathHint = (options: StorageRootHintOptions = {} as StorageRootHintOptions): string =>
  path.join(resolveDefaultStorageRoot(options), 'logs', 'backend.log');

const resolveBackendConfigFilePath = (options: StorageRootHintOptions = {} as StorageRootHintOptions): string =>
  path.join(resolveDefaultStorageRoot(options), 'config', 'backend.json');

const resolvePromptPresetsFilePath = (options: StorageRootHintOptions = {} as StorageRootHintOptions): string =>
  path.join(resolveDefaultStorageRoot(options), 'config', 'prompt-presets.json');

export = {
  resolveDefaultStorageRoot,
  resolveBackendLogPathHint,
  resolveBackendConfigFilePath,
  resolvePromptPresetsFilePath,
};
