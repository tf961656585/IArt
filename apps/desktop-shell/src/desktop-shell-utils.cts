import { app } from "electron";
import type * as Contracts from "@iart/contracts";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import storageHintsModule = require("@iart/utils/storage-root-hints");
import { loadRuntimeEnv } from "./utils/runtime-env-loader.cjs";
import {
  resolveEditorWindowTarget,
  resolveHubWindowTarget,
} from "./window/frontend-entry-resolver.cjs";

export const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
export const PRELOAD_PATH = path.join(__dirname, "preload.cjs");
export const nodeRequire = createRequire(__filename);
type HubLocalWriteTokenEnvKey = typeof Contracts.HUB_LOCAL_WRITE_TOKEN_ENV;

export type DesktopEnv = {
  IART_APP_VERSION: string | undefined;
  IART_DEV_EDITOR_URL: string | undefined;
  IART_EDITOR_STATIC_DIR: string | undefined;
  IART_HUB_DEV_URL: string | undefined;
  IART_HUB_STATIC_DIR: string | undefined;
  IART_BACKEND_PORT: string | undefined;
  IART_BACKEND_BASE_URL: string | undefined;
  IART_SQLITE_RUNTIME: string | undefined;
  IART_MODEL_ASSET_PACKAGES_DIR: string | undefined;
  IART_SKILL_RUNTIME_DIR: string | undefined;
  IART_E2E_REPORT_PATH: string | undefined;
  IART_E2E_AUTO_EXIT: string | undefined;
  IART_E2E_OPEN_EDITOR_PROJECT_PATH: string | undefined;
  HOME: string | undefined;
  USERPROFILE: string | undefined;
  NODE_ENV: string | undefined;
} & Record<HubLocalWriteTokenEnvKey, string | undefined>;

export const getDesktopEnv = (): DesktopEnv => process.env as DesktopEnv;
export const cloneDesktopEnv = (): DesktopEnv =>
  ({ ...process.env }) as DesktopEnv;
export const normalizeDesktopString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : "";
export const isObjectLike = (value: unknown): value is object =>
  typeof value === "object" && value !== null;
export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type DesktopStringFields = {
  path: unknown | undefined;
  taskId: unknown | undefined;
  url: unknown | undefined;
  projectPath: unknown | undefined;
  text: unknown | undefined;
  type: unknown | undefined;
  title: unknown | undefined;
  defaultPath: unknown | undefined;
  buttonLabel: unknown | undefined;
  detail: unknown | undefined;
  code: unknown | undefined;
  message: unknown | undefined;
  backendBaseUrl: unknown | undefined;
};

export const asDesktopStringFields = (
  value: unknown,
): DesktopStringFields | null =>
  isObjectLike(value) ? (value as DesktopStringFields) : null;

export const getStringField = (
  value: unknown,
  key: keyof DesktopStringFields,
): string => {
  const fields = asDesktopStringFields(value);
  const fieldValue = (fields !== null && fields !== undefined ? fields[key] : undefined);
  return typeof fieldValue === "string" ? fieldValue : "";
};

export const loadRuntimeEnvOnce = () => {
  loadRuntimeEnv({ repoRoot: ROOT_DIR, execDir: undefined, cwd: undefined, packagedAppRoot: undefined, resourcesDir: undefined });
};

export const resolveAppVersion = () => {
  const envVersion = String(getDesktopEnv().IART_APP_VERSION || "").trim();
  if (envVersion) return envVersion;
  try {
    const pkg = nodeRequire(path.join(ROOT_DIR, "package.json")) as {
      version: unknown | undefined;
    };
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch {
    void 0;
  }
  try {
    return app.getVersion();
  } catch {
    return "";
  }
};

const getPackagedAppRoot = () => {
  try {
    const appPath = app.getAppPath();
    if (appPath && fs.existsSync(appPath)) return appPath;
  } catch {
    void 0;
  }
  return null;
};

export const resolveBackendEntry = () => {
  if (!app.isPackaged) {
    return path.join(ROOT_DIR, "apps", "backend", "dist", "main.cjs");
  }
  const packagedRoot = getPackagedAppRoot();
  const asarEntry = packagedRoot
    ? path.join(packagedRoot, "apps", "backend", "dist", "main.cjs")
    : null;
  if (asarEntry && fs.existsSync(asarEntry)) return asarEntry;
  const resourcesRoot =
    typeof process.resourcesPath === "string" && process.resourcesPath.trim()
      ? process.resourcesPath
      : ROOT_DIR;
  return path.join(resourcesRoot, "apps", "backend", "dist", "main.cjs");
};

export const resolveEditorStaticRoot = () => {
  if (!app.isPackaged)
    return path.join(ROOT_DIR, "apps", "editor", "dist-static");
  const packagedRoot = getPackagedAppRoot();
  const asarRoot = packagedRoot
    ? path.join(packagedRoot, "apps", "editor", "dist-static")
    : null;
  return asarRoot && fs.existsSync(asarRoot)
    ? asarRoot
    : path.join(process.resourcesPath, "apps", "editor", "dist-static");
};

export const resolveHubStaticRoot = () => {
  if (!app.isPackaged) return path.join(ROOT_DIR, "apps", "hub", "dist-static");
  const packagedRoot = getPackagedAppRoot();
  const asarRoot = packagedRoot
    ? path.join(packagedRoot, "apps", "hub", "dist-static")
    : null;
  return asarRoot && fs.existsSync(asarRoot)
    ? asarRoot
    : path.join(process.resourcesPath, "apps", "hub", "dist-static");
};

export const resolveHubStartUrl = () =>
  resolveHubWindowTarget({
    devUrl: getDesktopEnv().IART_HUB_DEV_URL ?? null,
    staticRoot: resolveHubStaticRoot(),
  });

export const resolveEditorStartUrl = (backendBaseUrl: string | null) =>
  resolveEditorWindowTarget({
    devUrl: getDesktopEnv().IART_DEV_EDITOR_URL ?? null,
    backendBaseUrl,
    staticRoot: undefined,
  });

const escapeHtml = (text: unknown) =>
  String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

type StaticErrorPageDetail = {
  label: string;
  value: string | number | boolean | null | undefined;
};

const normalizeStaticErrorPageDetails = (
  details: readonly StaticErrorPageDetail[] | undefined,
) => (details ?? []).filter((item) => item.value !== undefined);

const readStaticErrorText = (error: unknown): string | null => {
  if (!error) return null;
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
};

export const resolveDefaultStorageRootHint = () =>
  String(
    storageHintsModule.resolveDefaultStorageRoot({
      env: undefined,
      globalObject: undefined,
      platform: undefined,
      homeDir: undefined,
      execPath: undefined,
      moduleDir: undefined,
      devFallbackRoot: ROOT_DIR,
      isElectronRuntime: undefined,
    }) || "",
  ).trim();

/**
 * backend 业务日志目录（存储根 logs/，backend.log 所在目录）。
 * 与 resolveDefaultStorageRootHint 同参解析：backend 业务日志 dev 与安装版共享同一存储根
 * （docs/desktop-updates/排查日志-dev-与安装版分流.md），路径知识归主进程，
 * 渲染层不自持路径（docs/editor/本地文件快捷跳转.md LFJ-008）。
 * 存储根未解析时返回空串，由调用方给失败反馈。
 */
export const resolveBackendLogDirHint = (): string => {
  const root = resolveDefaultStorageRootHint();
  return root ? path.join(root, "logs") : "";
};

export const resolvePromptPresetsFilePathHint = () =>
  String(
    storageHintsModule.resolvePromptPresetsFilePath({
      env: undefined,
      globalObject: undefined,
      platform: undefined,
      homeDir: undefined,
      execPath: undefined,
      moduleDir: undefined,
      devFallbackRoot: ROOT_DIR,
      isElectronRuntime: undefined,
    }) || "",
  ).trim();

export const resolveStaticErrorPageUrl = ({
  title,
  detail,
  error,
  currentUrl,
  reloadUrl,
  details,
}: {
  title: string;
  detail: string | undefined;
  error: unknown | undefined;
  currentUrl: string | null | undefined;
  reloadUrl: string | null | undefined;
  details: readonly StaticErrorPageDetail[] | undefined;
}) => {
  const normalizedDetails = normalizeStaticErrorPageDetails(details);
  const defaultStorageRoot = resolveDefaultStorageRootHint() || "<数据目录>";
  const errorText = readStaticErrorText(error);
  const lines = [
    detail || "前端入口不可用。",
    `默认数据目录：${defaultStorageRoot}`,
  ];
  const diagnostic = JSON.stringify(
    {
      title,
      detail: detail || null,
      currentUrl: currentUrl || null,
      reloadUrl: reloadUrl || null,
      defaultStorageRoot,
      details: normalizedDetails,
      error: errorText,
      devConsoleShortcuts: ["F12", "Ctrl+Shift+I", "Cmd+Shift+I"],
    },
    null,
    2,
  );
  const detailList = normalizedDetails.length
    ? `<dl>${normalizedDetails
        .map(
          (item) =>
            `<div class="row"><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(
              item.value ?? "",
            )}</dd></div>`,
        )
        .join("")}</dl>`
    : "";
  const currentUrlText = currentUrl
    ? `<div class="row"><dt>当前 URL</dt><dd>${escapeHtml(currentUrl)}</dd></div>`
    : "";
  const errorBlock = errorText
    ? `<h3>错误详情</h3><pre>${escapeHtml(errorText)}</pre>`
    : "";
  const style = [
    "body{font-family:Segoe UI,Microsoft YaHei,Arial,sans-serif;margin:0;padding:24px;line-height:1.6;background:#f8fafc;color:#0f172a}",
    ".wrap{max-width:980px;margin:0 auto}",
    ".panel{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:20px;box-shadow:0 1px 2px rgba(15,23,42,.08)}",
    "h2{margin:0 0 12px;font-size:22px}",
    "h3{margin:20px 0 8px;font-size:15px}",
    ".actions{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}",
    ".button{border:1px solid #94a3b8;background:#0f172a;color:#fff;border-radius:6px;padding:7px 12px;font:inherit;cursor:pointer}",
    ".button.secondary{background:#fff;color:#0f172a}",
    "pre{white-space:pre-wrap;word-break:break-word;background:#111827;color:#f8fafc;padding:12px;border-radius:8px;overflow:auto;max-height:46vh}",
    "dl{margin:12px 0 0}",
    ".row{display:grid;grid-template-columns:140px minmax(0,1fr);gap:10px;margin:6px 0}",
    "dt{font-weight:600;color:#475569}",
    "dd{margin:0;word-break:break-all}",
    ".hint{color:#475569;font-size:13px}",
  ].join("");
  const script = [
    'const copyButton=document.getElementById("copyDiagnostic");',
    'const reloadButton=document.getElementById("reloadEntry");',
    'copyButton&&copyButton.addEventListener("click",()=>{',
    'const text=document.getElementById("diagnostic")?.innerText||"";',
    'navigator.clipboard?.writeText(text).then(()=>{copyButton.textContent="已复制"}).catch(()=>{copyButton.textContent="复制失败"});',
    "});",
    'reloadButton&&reloadButton.addEventListener("click",()=>{',
    'const url=reloadButton.getAttribute("data-url");',
    "if(url){window.location.href=url;}else{window.location.reload();}",
    "});",
  ].join("");
  const html = [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8"/>',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${style}</style>`,
    "</head>",
    "<body>",
    '<div class="wrap"><div class="panel">',
    `<h2>${escapeHtml(title)}</h2>`,
    `<p>${lines.map(escapeHtml).join("<br/>")}</p>`,
    '<p class="hint">可按 F12、Ctrl+Shift+I 或 Cmd+Shift+I 打开当前窗口 DevConsole。</p>',
    '<div class="actions">',
    '<button id="copyDiagnostic" class="button">复制错误详情</button>',
    `<button id="reloadEntry" class="button secondary" data-url="${escapeHtml(reloadUrl || "")}">重新加载</button>`,
    "</div>",
    currentUrlText,
    detailList,
    errorBlock,
    "<h3>诊断信息</h3>",
    `<pre id="diagnostic">${escapeHtml(diagnostic)}</pre>`,
    "</div></div>",
    `<script>${script}</script>`,
    "</body>",
    "</html>",
  ].join("");
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

export const probeHttpHealth = async (origin: string) => {
  const base = normalizeDesktopString(origin).replace(/\/+$/, "");
  if (!base || typeof fetch !== "function") {
    return { ok: false, url: "", error: "fetch not available" };
  }
  const url = `${base}/health`;
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
    });
    return { ok: response.ok, url, status: response.status };
  } catch (error) {
    return { ok: false, url, error: toErrorMessage(error) };
  }
};
