import * as httpUtilsModule from "../http-utils.cts";
import type { RouteDefinition } from "../http/route-registry.cts";
import { ExecutableModelCatalogResponseSchema } from "@iart/contracts";
import { listExecutableCatalogEntries } from "../model-catalog-entry.cts";

const { sendJson } = httpUtilsModule;

/**
 * 可执行模型目录（GET /api/executable-model-catalog，spec 45 §1/§3）。
 *
 * 只呈现已闭合生成族的模型：Seedance 2.5 契约未闭合、非生成族（TTS / 文本等）不进
 * 可提交目录。对话模型（用户自建声明）不进本端点——它们走
 * GET /api/chat-model-catalog（spec 03 §1：对话能力不进 PromptDock 目录）。
 *
 * 条目投影、过滤口径与可执行性判定见 ../model-catalog-entry.cts 的 listExecutableCatalogEntries
 * （与 agent 工具注册表共用，不各自复制）。
 */
const handleExecutableModelCatalog = (
  corsHeaders: Record<string, string>,
  res: Parameters<RouteDefinition["handle"]>[0]["res"],
) => {
  const payload = ExecutableModelCatalogResponseSchema.parse({
    models: listExecutableCatalogEntries(),
  });
  sendJson(res, 200, payload, corsHeaders);
};

const createExecutableModelCatalogRoutes = (): RouteDefinition[] => [
  {
    name: "executable-model-catalog",
    match: ({ req, pathname }) => req.method === "GET" && pathname === "/api/executable-model-catalog",
    handle: ({ res, corsHeaders }) => {
      handleExecutableModelCatalog(corsHeaders, res);
    },
  },
];

export { createExecutableModelCatalogRoutes };
