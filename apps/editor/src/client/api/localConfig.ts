import { request } from "@/client/api/client";
import {
  resolveLocalApiRequestTarget,
} from "@/client/utils/apiConfig";

export type LocalLogLevel = "debug" | "info" | "warn" | "error";

export interface LocalBackendConfig {
  version: number | undefined;
  preferredPort: number | undefined;
  logLevel: LocalLogLevel | undefined;
  maxUploadSize: number | undefined;
  maxMediaSize: number | undefined;
  /** 画板内批量执行：单次点击最大任务数 */
  maxBatchTasks: number | undefined;
  /** 画板模型节点参数区：启动时是否默认展开（false=默认收起） */
  expandInlineParamsOnStartup: boolean | undefined;
  /**
   * Agent 形态的默认模型（主窗口「服务商」区域设置）：创作面进入 agent 形态且未选模型时预选它。
   * 缺省 / null = 没设默认，创作面保持未选择。
   */
  agentDefaultModelId?: string | null | undefined;
  /**
   * PromptDock **生成形态**的默认模型（主窗口「服务商」区域设置）：画布里的生成形态
   * 还没选过模型时预选它。缺省 / null = 没设默认，按产品口径的内置首选预选；
   * 它不在可执行目录里时同样按「没设默认」处理（回落内置首选，不阻断创作面）。
   */
  generationDefaultModelId?: string | null | undefined;
  allowedRemoteHosts: string[] | undefined;
}

export interface LocalBackendResolvedConfig {
  preferredPort: number;
  logLevel: LocalLogLevel;
  maxUploadSize: number;
  maxMediaSize: number;
  /** 画板内批量执行：单次点击最大任务数 */
  maxBatchTasks: number;
  /** 画板模型节点参数区：启动时是否默认展开（false=默认收起） */
  expandInlineParamsOnStartup: boolean;
  allowedRemoteHosts: string[];
}

export interface LocalBackendConfigResponse {
  config: LocalBackendConfig;
  resolved: LocalBackendResolvedConfig;
  server: {
    port: number | null;
    baseUrl: string | null;
  } | undefined;
}

const buildLocalConfigRequestOptions = async (): Promise<{
  endpoint: string;
  resolveEndpoint: boolean | undefined;
}> => resolveLocalApiRequestTarget("/api/config", {
  allowRelativeFallback: true,
  allowStoredFallback: undefined,
});

export const fetchLocalBackendConfig = async (): Promise<LocalBackendConfigResponse> => {
  const target = await buildLocalConfigRequestOptions();
  return request<LocalBackendConfigResponse>({
    ...target,
    includeAuth: false,
    cache: "no-store",
  });
};

export const updateLocalBackendConfig = async (
  payload: Partial<LocalBackendConfig>
): Promise<LocalBackendConfigResponse> => {
  const target = await buildLocalConfigRequestOptions();
  return request<LocalBackendConfigResponse>({
    method: "PUT",
    ...target,
    includeAuth: false,
    body: payload,
  });
};
