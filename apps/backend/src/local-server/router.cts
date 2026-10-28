import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";

import * as constantsModule from "./constants.cts";
import { runHttpRoutes } from "./http/route-registry.cts";
import * as httpUtilsModule from "./http-utils.cts";
import * as loggingModule from "./logging.cts";
import * as mimeModule from "./mime.cts";
import * as modelPackageCatalogModule from "./model-package-catalog.cts";
import { createCharacterRoutes } from "./routes/character-routes.cts";
import { createChatModelCatalogRoutes } from "./routes/chat-model-catalog-routes.cts";
import { createCustomChatModelRoutes } from "./routes/custom-chat-model-routes.cts";
import { createCustomGenerationModelRoutes } from "./routes/custom-generation-model-routes.cts";
import { onCustomGenerationModelsChanged } from "./provider-connection/custom-generation-model-store.cts";
import { onCustomChatModelsChanged } from "./provider-connection/custom-chat-model-store.cts";
import { onInterfaceRecipesChanged } from "./provider-connection/interface-recipe-store.cts";
import { createOnboardingRoutes } from "./routes/onboarding-routes.cts";
import { createExecutableModelCatalogRoutes } from "./routes/executable-model-catalog-routes.cts";
import { createFileRoutes } from "./routes/file-routes.cts";
import { createGenerationBatchRoutes } from "./routes/generation-batch-routes.cts";
import { createGenerationFamilyTemplateRoutes } from "./routes/generation-family-template-routes.cts";
import { createInterfaceFormatRoutes } from "./routes/interface-format-routes.cts";
import { createInterfaceRecipeRoutes } from "./routes/interface-recipe-routes.cts";
import { createProviderConnectionRoutes } from "./routes/provider-connection-routes.cts";
import { createMediaRoutes } from "./routes/media-routes.cts";
import { createProxyRoutes } from "./routes/proxy-routes.cts";
import { createPromptPresetRoutes } from "./routes/prompt-preset-routes.cts";
import { createSystemRoutes } from "./routes/system-routes.cts";
import { createTaskRoutes } from "./routes/task-routes.cts";
import { createThinkingTierRoutes } from "./routes/thinking-tier-routes.cts";
import { createUploadRoutes } from "./routes/upload-routes.cts";
import * as safePathModule from "./safe-path.cts";
import * as storageModule from "./storage.cts";
import {
  isHubLocalWriteGuardedRoute,
  isHubLocalWriteProbeRoute,
} from "./hub-local-write-policy.cts";
import { verifyHubLocalWriteTrust } from "./hub-local-write-trust.cts";

type RouterRequest = IncomingMessage;
type RouterResponse = ServerResponse<IncomingMessage>;
type RouteOptionsLike = { baseDir: unknown | undefined; editorStaticRoot: unknown | undefined };

const { HOST, ERROR_CODES } = constantsModule;
const { buildCorsHeaders, sendError } = httpUtilsModule;
const { isValidProjectFolder } = storageModule;
const { logError } = loggingModule;
const { getMimeType } = mimeModule;
const { safeJoin } = safePathModule;
const { createModelProjectionSnapshotCatalog } = modelPackageCatalogModule;

let serverPort: number | null = null;
const setServerPort = (value: unknown) => {
  serverPort = Number.isFinite(value) ? Number(value) : null;
};
const getServerPort = () => serverPort;

const isJsonObject = (value: unknown): value is object =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const getRouteOptionsLike = (value: unknown): RouteOptionsLike | null => (isJsonObject(value) ? value as RouteOptionsLike : null);
const normalizeString = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");
const bytesPerMB = 1024 * 1024;
const formatBytes = (bytes: unknown) => {
  const numericBytes = Number.isFinite(bytes) ? Number(bytes) : 0;
  if (numericBytes <= 0) return `${numericBytes} bytes`;
  if (numericBytes < bytesPerMB) return `${numericBytes} bytes`;
  const mb = numericBytes / bytesPerMB;
  const rounded = mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10;
  return `${rounded}MB (${numericBytes} bytes)`;
};
const buildFileTooLargeMessage = (maxBytes: unknown) =>
  [
    `文件大小超过上传限制（${formatBytes(maxBytes)}）。`,
    "可在「设置 -> 本地后台设置」调大“最大上传大小”，",
    "或设置环境变量 IART_MAX_UPLOAD（单位：bytes）。",
  ].join("");

const normalizeStaticRoot = (value: unknown) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
};
const isEditorStaticAssetRequest = (pathname: unknown) => /\.[a-z0-9]+$/i.test(path.basename(String(pathname || "")));
const resolveEditorStaticRequest = (editorStaticRoot: unknown, pathname: unknown) => {
  const root = normalizeStaticRoot(editorStaticRoot);
  if (!root) return null;
  const normalizedPathname = typeof pathname === "string" ? pathname : "/editor/";
  if (
    normalizedPathname !== "/editor" &&
    normalizedPathname !== "/editor/" &&
    !normalizedPathname.startsWith("/editor/")
  )
    return null;
  const relativePath = normalizedPathname.replace(/^\/editor\/?/, "");
  const requestedPath = relativePath ? safeJoin(root, relativePath) : null;
  if (requestedPath && fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()) {
    return { filePath: requestedPath, cacheControl: "public, max-age=3600" };
  }
  if (relativePath && isEditorStaticAssetRequest(relativePath)) return null;
  const indexPath = path.join(root, "index.html");
  if (!fs.existsSync(indexPath)) return null;
  return { filePath: indexPath, cacheControl: "no-cache" };
};

const createRequestHandler = (options: unknown = {}) => {
  const optionsRecord = getRouteOptionsLike(options);
  const baseDir = normalizeString((optionsRecord !== null && optionsRecord !== undefined ? optionsRecord.baseDir : undefined)) || process.cwd();
  const editorStaticRoot = normalizeStaticRoot((optionsRecord !== null && optionsRecord !== undefined ? optionsRecord.editorStaticRoot : undefined));
  // node-projections 活快照：启动期不装配（不急切读声明 store）；首个投影请求装配，
  // 声明写入落盘成功后失效，下一次请求单飞重建（机制见 createModelProjectionSnapshotCatalog）。
  const modelProjectionSnapshot = createModelProjectionSnapshotCatalog({ baseDir });
  onCustomGenerationModelsChanged(modelProjectionSnapshot.invalidate);
  // 对话侧自建记录变更同样使投影快照失效（对齐生成侧模式；记录改档位/删除即失效重建）。
  onCustomChatModelsChanged(modelProjectionSnapshot.invalidate);
  // 接口配方变更使引用它的记录投影失效（判定与结果段落来自配方；不重建会继续跑旧计划）。
  onInterfaceRecipesChanged(modelProjectionSnapshot.invalidate);
  const ensureProjectFilesResolvable = (projectPath: unknown) => {
    const normalizedProjectPath = typeof projectPath === "string" && projectPath.trim() ? projectPath.trim() : "";
    if (!normalizedProjectPath) return;
    if (!isValidProjectFolder(normalizedProjectPath)) return;
  };
  const registeredRoutes = [
    ...createSystemRoutes({ getServerPort, modelPackageCatalog: modelProjectionSnapshot.catalog }),
    ...createCharacterRoutes({ buildFileTooLargeMessage }),
    ...createExecutableModelCatalogRoutes(),
    ...createChatModelCatalogRoutes(),
    ...createCustomChatModelRoutes(),
    ...createCustomGenerationModelRoutes(),
    ...createGenerationFamilyTemplateRoutes(),
    ...createInterfaceFormatRoutes(),
    ...createInterfaceRecipeRoutes(),
    ...createOnboardingRoutes(),
    ...createProviderConnectionRoutes(),
    ...createThinkingTierRoutes(),
    ...createMediaRoutes({ getServerPort }),
    ...createUploadRoutes({ buildFileTooLargeMessage, getServerPort, ensureProjectFilesResolvable }),
    ...createFileRoutes(),
    ...createTaskRoutes(),
    ...createGenerationBatchRoutes(),
    ...createPromptPresetRoutes(),
    ...createProxyRoutes(),
  ];

  return async (req: RouterRequest, res: RouterResponse) => {
    try {
      const origin = req.headers.origin;
      const requestHeaders = req.headers["access-control-request-headers"];
      const corsHeaders = buildCorsHeaders(origin, requestHeaders || undefined);
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }
      const url = new URL(req.url || "/", `http://${HOST}`);
      const pathname = url.pathname;
      if (isHubLocalWriteGuardedRoute(req.method, pathname) || isHubLocalWriteProbeRoute(req.method, pathname)) {
        const trust = verifyHubLocalWriteTrust(req);
        if (!trust.ok) {
          sendError(res, 403, ERROR_CODES.ORIGIN_NOT_ALLOWED, "Origin not allowed", corsHeaders);
          return;
        }
      }
      const editorStaticRequest = resolveEditorStaticRequest(editorStaticRoot, pathname);
      if (editorStaticRequest && req.method === "GET") {
        const stat = fs.statSync(editorStaticRequest.filePath);
        res.writeHead(200, {
          "Content-Type": String(getMimeType(editorStaticRequest.filePath) || "application/octet-stream"),
          "Content-Length": stat.size,
          "Cache-Control": editorStaticRequest.cacheControl,
          ...corsHeaders,
        });
        fs.createReadStream(editorStaticRequest.filePath).pipe(res);
        return;
      }
      if (await runHttpRoutes(registeredRoutes, { req, res, url, pathname, corsHeaders })) return;
      sendError(res, 404, ERROR_CODES.NOT_FOUND, "Not found", corsHeaders);
    } catch (error) {
      const errorText = error instanceof Error ? String(error.stack || error.message) : String(error);
      let pathname = null;
      try {
        const parsed = new URL((req !== null && req !== undefined ? req.url : undefined) || "/", `http://${HOST}`);
        pathname = typeof parsed.pathname === "string" && parsed.pathname ? parsed.pathname : null;
      } catch {
        pathname = null;
      }
      try {
        logError("request handler crashed", {
          method: (req !== null && req !== undefined ? req.method : undefined) || null,
          url: (req !== null && req !== undefined ? req.url : undefined) || null,
          pathname,
          error: errorText,
        });
      } catch {
        void 0;
      }
      const origin = (req !== null && req !== undefined && req.headers !== null && req.headers !== undefined ? req.headers.origin : undefined);
      const requestHeaders = (req !== null && req !== undefined && req.headers !== null && req.headers !== undefined ? req.headers["access-control-request-headers"] : undefined);
      const corsHeaders = buildCorsHeaders(origin, requestHeaders || undefined);
      if (res && typeof res.writeHead === "function" && typeof res.end === "function") {
        try {
          if (!res.headersSent) sendError(res, 500, ERROR_CODES.INTERNAL_ERROR, "Internal server error", corsHeaders);
        } catch {
          try {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders });
            res.end("Internal server error");
          } catch {
            void 0;
          }
        }
      }
    }
  };
};

export { createRequestHandler, setServerPort, getServerPort };
