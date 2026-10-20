import * as httpUtilsModule from "../http-utils.cts";
import type { RouteDefinition } from "../http/route-registry.cts";
import { ExecutableModelCatalogResponseSchema } from "@iart/contracts";
import { listExecutableCatalogEntries } from "../model-catalog-entry.cts";

const { sendJson } = httpUtilsModule;

/**
 * 可执行模型目录（GET /api/executable-model-catalog，spec 45 §1/§3）。
 *
 * 只呈现「用户模型记录 × 已就绪族模板」合成出的模型（spec 03 PC-15：模型唯一来源是用户记录，
 * 软件不内置任何具体模型）。准入判据只有一条：记录的 `family_adapter_id` 指向一个已就绪的族
 * 模板。对话模型记录不进本端点——它们走 GET /api/chat-model-catalog
 * （spec 03 §1：对话能力不进 PromptDock 目录）。
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
