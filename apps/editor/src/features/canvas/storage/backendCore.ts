import { setCurrentProjectPathToElectron } from "@/client/utils/electronBridge";
import type { DynamicRecord } from '@/client/utils/typeGuards';
import { getRuntimeProjectPath } from "@/client/store/runtimeStore";
import { normalizeProjectMediaAssets } from "../services/projectMediaAssets";
import type { ProjectRecord } from "./types";

const getStorage = () => {
  if (typeof window === "undefined") return null;
  return (window.electron !== null && window.electron !== undefined ? window.electron.storage : undefined) ?? null;
};

export const ipcInvoke = async <T>(channel: string, args: unknown | undefined): Promise<T> => {
  const storage = getStorage();
  if (!storage || typeof storage[channel] !== "function") {
    throw new Error("无法读写本地数据，请重启应用后再试。");
  }
  return (storage[channel] as (args: unknown | undefined) => Promise<T>)(args);
};

export const normalizeProjectRecord = (project: unknown): ProjectRecord | null => {
  if (!project || typeof project !== "object") return null;
  const record = project as DynamicRecord;
  const { mediaAssets: rawMediaAssets } = record as { mediaAssets: unknown | undefined };
  return {
    ...record,
    mediaAssets: normalizeProjectMediaAssets(rawMediaAssets as ProjectRecord["mediaAssets"] | undefined),
  } as ProjectRecord;
};

export const getCurrentProjectPath = async (): Promise<string | null> => getRuntimeProjectPath();

export const setCurrentProjectPath = async (projectPath: string | null): Promise<void> => {
  return setCurrentProjectPathToElectron(projectPath);
};

export const normalizeStringKeys = (value: unknown): string[] => {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const normalized = raw
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return Array.from(new Set(normalized));
};
