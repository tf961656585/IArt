export interface ProjectEnv {
  NODE_ENV: string | undefined;

  IART_STORAGE_ROOT: string | undefined;
  IART_DATA_ROOT: string | undefined;
  IARTS_DATA_ROOT: string | undefined;
  LOCALAPPDATA: string | undefined;
  APPDATA: string | undefined;
  XDG_DATA_HOME: string | undefined;

  IART_BACKEND_PORT: string | undefined;
  IART_BACKEND_BASE_URL: string | undefined;
  IART_APP_VERSION: string | undefined;
  IART_SOFTWARE_VERSION: string | undefined;
  npm_package_version: string | undefined;
  IART_DEV_EDITOR_URL: string | undefined;
  IART_EDITOR_STATIC_DIR: string | undefined;
  IART_HUB_DEV_URL: string | undefined;
  IART_HUB_STATIC_DIR: string | undefined;
  IART_SQLITE_RUNTIME: string | undefined;
  IART_MODEL_ASSET_PACKAGES_DIR: string | undefined;

  IART_LOG_LEVEL: string | undefined;
  IART_MAX_UPLOAD: string | undefined;
  IART_MAX_MEDIA: string | undefined;
  IART_MAX_BATCH_TASKS: string | undefined;
  IART_MEDIA_TIMEOUT: string | undefined;

  IART_ENV_FILE: string | undefined;

  IART_PUBLIC_UPLOAD_CLOUDFLARE_IMAGE_PUBLIC_URL_ENDPOINT: string | undefined;
  IART_PUBLIC_UPLOAD_SELF_HOSTED_IMAGE_PUBLIC_URL_ENDPOINT: string | undefined;

  IART_E2E_REPORT_PATH: string | undefined;
  IART_E2E_AUTO_EXIT: string | undefined;
  IART_E2E_TIMEOUT_MS: string | undefined;
  IART_E2E_OPEN_EDITOR_PROJECT_PATH: string | undefined;

  IART_DEVTOOLS: string | undefined;
  IART_DESKTOP_EXPORT: string | undefined;

  VITEST: string | undefined;
}
