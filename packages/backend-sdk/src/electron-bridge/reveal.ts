import {
  RevealProjectFolderResultSchema,
} from "@iart/contracts";
import type {
  ElectronBridge,
  RevealFilesUrlResult,
  RevealFolderResult,
  RevealTaskArchiveResult,
} from "./types";

const isString = (value: unknown): value is string => typeof value === "string";

const getBrowserElectronBridge = (): ElectronBridge | null => {
  if (typeof window === "undefined") {
    return null;
  }
  return window.electron ?? null;
};

const isValidRevealFilesUrlResult = (
  value: unknown,
): value is RevealFilesUrlResult => {
  if (!value || typeof value !== "object") return false;
  const result = value as {
    ok: unknown | undefined;
    reason: unknown | undefined;
    fileKey: unknown | undefined;
    dir: unknown | undefined;
    filePath: unknown | undefined;
  };
  if (typeof result.ok !== "boolean") return false;
  return (
    (result.reason === undefined || isString(result.reason)) &&
    (result.fileKey === undefined || isString(result.fileKey)) &&
    (result.dir === undefined || isString(result.dir)) &&
    (result.filePath === undefined || isString(result.filePath))
  );
};

export const revealTaskArchive = async (
  taskId: string,
  projectPath: string | null | undefined,
): Promise<RevealTaskArchiveResult> => {
  const api = getBrowserElectronBridge();
  if (typeof window === "undefined") {
    return { ok: false, reason: "not-in-browser" };
  }
  if (!api || typeof api.revealTaskArchive !== "function") {
    return { ok: false, reason: "not-in-electron" };
  }

  const trimmedTaskId = isString(taskId) ? taskId.trim() : "";
  if (!trimmedTaskId) {
    return { ok: false, reason: "missing-task-id" };
  }

  try {
    const result = await api.revealTaskArchive(
      trimmedTaskId,
      projectPath ?? null,
    );
    if (result && typeof result === "object" && "ok" in result) {
      const candidate = result as { ok: unknown; dir: unknown; reason: unknown };
      if (candidate.ok === true && typeof candidate.dir === "string") {
        return { ok: true, dir: candidate.dir };
      }
      const reason = typeof candidate.reason === "string" ? candidate.reason : "unknown";
      console.warn("revealTaskArchive: request failed", {
        taskId: trimmedTaskId,
        projectPath: projectPath ?? null,
        reason,
        result,
      });
      return { ok: false, reason };
    }
    return { ok: false, reason: "invalid-response" };
  } catch (error) {
    console.warn("revealTaskArchive: failed to reveal task archive", error);
    return { ok: false, reason: "invoke-failed" };
  }
};

export const revealFilesUrl = async (
  url: string,
  projectPath: string | null | undefined,
): Promise<RevealFilesUrlResult> => {
  const api = getBrowserElectronBridge();
  if (typeof window === "undefined") {
    return { ok: false, reason: "not-in-browser" };
  }
  if (!api || typeof api.revealFilesUrl !== "function") {
    return { ok: false, reason: "not-in-electron" };
  }

  const trimmedUrl = isString(url) ? url.trim() : "";
  if (!trimmedUrl) {
    return { ok: false, reason: "missing-url" };
  }

  try {
    const result = await api.revealFilesUrl(trimmedUrl, projectPath ?? null);
    return isValidRevealFilesUrlResult(result)
      ? result
      : { ok: false, reason: "invalid-response" };
  } catch (error) {
    console.warn("revealFilesUrl: failed to reveal files url", error);
    return { ok: false, reason: "invoke-failed" };
  }
};

/**
 * 定位项目目录或导出文件（spec docs/editor/本地文件快捷跳转.md）。
 *
 * 同一通道服务目录类（Hub 项目卡「打开所在文件夹」）与文件类（导出 .iarts.zip
 * 完成反馈历史特例）两种语义；路径解析与存在性校验归主进程。
 *
 * 失败语义：
 * - not-in-browser / not-in-electron：运行环境不支持
 * - not-absolute：路径为空（主进程侧还会校验绝对性）
 * - invalid-response：主进程响应无法通过 schema 校验
 * - invoke-failed：IPC 调用抛错
 * - 其它 reason（not-absolute / path-missing）来自主进程
 *
 * 主进程已对响应做 .parse()，这里再用 safeParse() 兜底防御主进程畸形数据（双边界校验）。
 */
export const revealProjectFolder = async (
  projectPath: string,
): Promise<RevealFolderResult> => {
  const api = getBrowserElectronBridge();
  if (typeof window === "undefined") {
    return { ok: false, reason: "not-in-browser" };
  }
  if (!api || typeof api.revealProjectFolder !== "function") {
    return { ok: false, reason: "not-in-electron" };
  }
  const trimmedPath = isString(projectPath) ? projectPath.trim() : "";
  if (!trimmedPath) {
    return { ok: false, reason: "not-absolute" };
  }
  try {
    const result = await api.revealProjectFolder(trimmedPath);
    const parsed = RevealProjectFolderResultSchema.safeParse(result);
    if (parsed.success) {
      return parsed.data;
    }
    console.warn("revealProjectFolder: invalid response from main", {
      error: parsed.error.message,
      result,
    });
    return { ok: false, reason: "invalid-response" };
  } catch (error) {
    console.warn("revealProjectFolder: failed to reveal project folder", error);
    return { ok: false, reason: "invoke-failed" };
  }
};
