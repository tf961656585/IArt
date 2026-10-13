import * as httpUtilsModule from "../http-utils.cts";
import type { RouteDefinition } from "../http/route-registry.cts";
import {
  ChatModelCatalogResponseSchema,
  type ChatModelDirectoryEntry,
} from "@iart/contracts";
import { buildChatCatalogEntry, projectCustomChatModelToCatalogItem } from "../model-catalog-entry.cts";
import { listCustomChatModels } from "../provider-connection/custom-chat-model-store.cts";

const { sendJson } = httpUtilsModule;

/**
 * 对话模型目录（GET /api/chat-model-catalog）。
 *
 * 候选**只有用户自建对话模型**：软件不再内置对话模型能力包，能力包也不再能声明
 * `chat_streaming` 驱动（spec 37「对话模型的唯一来源」）。原来这里还有一路「已装对话模型包 +
 * 同名时包优先」的合并，随包形态退场一并移除。
 *
 * 条目字段投影与可执行性判定与可执行目录同源，见 ../model-catalog-entry.cts。
 *
 * 与 GET /api/executable-model-catalog 分开的原因：对话模型不进 PromptDock 目录，混入旧端点
 * 会让 PromptDock 出现不可生成的模型。
 */
const handleChatModelCatalog = (
  corsHeaders: Record<string, string>,
  res: Parameters<RouteDefinition["handle"]>[0]["res"],
) => {
  const entries: ChatModelDirectoryEntry[] = [];
  for (const model of listCustomChatModels()) {
    const entry = buildChatCatalogEntry(projectCustomChatModelToCatalogItem(model));
    if (entry !== null) entries.push(entry);
  }
  const payload = ChatModelCatalogResponseSchema.parse({ models: entries });
  sendJson(res, 200, payload, corsHeaders);
};

const createChatModelCatalogRoutes = (): RouteDefinition[] => [
  {
    name: "chat-model-catalog",
    match: ({ req, pathname }) => req.method === "GET" && pathname === "/api/chat-model-catalog",
    handle: ({ res, corsHeaders }) => {
      handleChatModelCatalog(corsHeaders, res);
    },
  },
];

export { createChatModelCatalogRoutes };
