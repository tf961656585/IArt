import {
  AppUpdateStateSchema,
  type AppUpdateFile,
  type AppUpdateProgress,
  type AppUpdateState,
} from "@iart/contracts";
import {
  resolveCurrentAppVersion,
  resolveUpdateArch,
  resolveUpdateChannel,
  resolveUpdatePlatform,
} from "./app-update-runtime.cjs";
import { getUpdaterLogPath } from "./app-update-log.cjs";

export type UpdateStateStore = {
  state: AppUpdateState;
  setState: (state: AppUpdateState) => AppUpdateState;
  base: () => Omit<AppUpdateState, "status">;
};

export function createUpdateStateStore(): UpdateStateStore {
  let state: AppUpdateState = AppUpdateStateSchema.parse({
    ...baseFields(null),
    status: "idle",
  });

  const setState = (next: AppUpdateState): AppUpdateState => {
    state = AppUpdateStateSchema.parse(next);
    return state;
  };

  return {
    get state() {
      return state;
    },
    setState,
    base: () => baseFields(state.lastCheckedAt),
  };
}

export function baseFields(lastCheckedAt: number | null) {
  return {
    appVersion: resolveCurrentAppVersion(),
    channel: resolveUpdateChannel(),
    platform: resolveUpdatePlatform(),
    arch: resolveUpdateArch(),
    lastCheckedAt,
    logPath: getUpdaterLogPath(),
  };
}

export function checkingState(lastCheckedAt: number): AppUpdateState {
  return AppUpdateStateSchema.parse({ ...baseFields(lastCheckedAt), status: "checking" });
}

export function notAvailableState(lastCheckedAt: number | null, latestVersion: string | null): AppUpdateState {
  return AppUpdateStateSchema.parse({ ...baseFields(lastCheckedAt), status: "not-available", latestVersion });
}

export function availableState(params: {
  lastCheckedAt: number | null;
  latestVersion: string;
  releaseDate: string | null;
  notes: string | null;
  files: AppUpdateFile[];
  mandatory: boolean;
  minimumVersion: string | null;
}): AppUpdateState {
  return AppUpdateStateSchema.parse({ ...baseFields(params.lastCheckedAt), status: "available", ...params });
}

export function downloadingState(latestVersion: string, progress: AppUpdateProgress | null): AppUpdateState {
  return AppUpdateStateSchema.parse({ ...baseFields(Date.now()), status: "downloading", latestVersion, progress });
}

export function downloadedState(latestVersion: string, downloadPath: string | null, files: AppUpdateFile[]): AppUpdateState {
  // 引导式安装：安装动作按下载文件类型由 Hub / installUpdate 派生，投影不再产出 quit-and-install。
  const installActions = ["open-installer", "show-in-folder", "later"];
  return AppUpdateStateSchema.parse({
    ...baseFields(Date.now()),
    status: "downloaded",
    latestVersion,
    downloadPath,
    files,
    installActions,
  });
}

export function errorState(latestVersion: string | null, message: string, code: string | undefined): AppUpdateState {
  return AppUpdateStateSchema.parse({
    ...baseFields(Date.now()),
    status: "error",
    latestVersion,
    error: { message, ...(code ? { code } : {}) },
  });
}
