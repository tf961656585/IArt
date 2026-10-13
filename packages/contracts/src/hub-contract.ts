import * as z from 'zod';
import type { UnifiedGenerationStatus } from './unified-generation';
import { UnifiedGenerationStatusSchema } from './schemas/runtime-transaction.schema';
import { PublicRelayTargetSettingsSchema, type PublicRelayTargetSettings } from './public-relay-contract';

export const HUB_LOCAL_WRITE_TOKEN_HEADER = 'x-iart-hub-write-token';
export const HUB_LOCAL_WRITE_TOKEN_ENV = 'IART_HUB_LOCAL_WRITE_TOKEN';

export const HubLocalWriteTokenSchema = z.string().trim().min(32);
export const HubLocalWriteTrustProbeResponseSchema = z.object({
  success: z.literal(true),
}).strict();

export const HubDesktopBootstrapSchema = z.object({
  runtime: z.literal('desktop-hub'),
  backendBaseUrl: z.string().min(1),
  hubWriteToken: HubLocalWriteTokenSchema,
}).strict();

export const PROXY_MODES = ['system', 'direct', 'manual'] as const;
export const ProxyModeSchema = z.enum(PROXY_MODES);
export type ProxyMode = z.infer<typeof ProxyModeSchema>;

export const HubConfigSchema = z.object({
  version: z.number().optional(),
  preferredPort: z.number().optional(),
  logLevel: z.string().optional(),
  maxUploadSize: z.number().optional(),
  maxMediaSize: z.number().optional(),
  maxBatchTasks: z.number().optional(),
  expandInlineParamsOnStartup: z.boolean().optional(),
  allowedRemoteHosts: z.array(z.string()).optional(),
  /**
   * Agent 形态的默认模型（spec docs/agent/06「agent 形态的输入面」）：创作面进入 agent 形态、
   * 且当前还没有选模型时，用它预选。null = 没设默认，创作面保持未选择，由用户自己挑。
   * 主窗口在该模型所属的已接入模型行上设置；模型被移除或不再可执行时由消费端按未设置处理。
   *
   * `config` 是整份本机配置的镜像（不是「本次更新」的补丁）：没设默认时后端如实写 null，
   * 与 `resolved` 的 null 语义一致。`.optional()` 只接 undefined，所以这里必须同时 nullable——
   * 否则任意一个默认模型未设置，Hub 读整份配置就会 parse 失败。
   */
  agentDefaultModelId: z.string().min(1).nullable().optional(),
  /**
   * 生成形态的默认模型（spec docs/hub/hub-information-architecture.md §7.4）：创作面进入生成形态、
   * 且当前还没有选模型时，优先用它预选。null = 没设默认，回落到产品口径的内置首选
   * （gpt-image-2 → 目录首个，spec docs/product/00-产品定位与核心动作.md「模型选择」）。
   * 主窗口在该模型所属的已接入模型行上设置；模型被移除或不在可执行目录时由消费端按未设置处理。
   *
   * 同上：null = 没设默认，与 `resolved` 的 null 语义一致，必须 nullable。
   */
  generationDefaultModelId: z.string().min(1).nullable().optional(),
  proxyMode: ProxyModeSchema.optional(),
  proxyUrl: z.string().optional(),
  /**
   * 用户自带的公共中转端点（「不再内置默认端点」语义，spec docs/runtime/public-relay-capability.md）。
   * 后端归一化恒输出两个中转类型（endpoint 可为空串 = 未配置），GET 镜像恒带该键；
   * `.optional()` 仅容忍异常缺失，不表示「未设置」。空串语义与替换规则见
   * PublicRelayTargetSettingsSchema 注释。
   */
  publicRelayTargets: PublicRelayTargetSettingsSchema.optional(),
});

export const HubConfigResolvedSchema = z.object({
  preferredPort: z.number(),
  logLevel: z.string(),
  maxUploadSize: z.number(),
  maxMediaSize: z.number(),
  maxBatchTasks: z.number(),
  expandInlineParamsOnStartup: z.boolean(),
  agentDefaultModelId: z.string().nullable(),
  generationDefaultModelId: z.string().nullable(),
  allowedRemoteHosts: z.array(z.string()),
  proxyMode: ProxyModeSchema,
  proxyUrl: z.string().nullable(),
});

export const HubServerRuntimeSchema = z.object({
  port: z.number().nullable(),
  baseUrl: z.string().nullable(),
});

export const HubConfigResponseSchema = z.object({
  config: HubConfigSchema,
  resolved: HubConfigResolvedSchema,
  server: HubServerRuntimeSchema,
});

export type HubLocalWriteTrustProbeResponse = z.infer<typeof HubLocalWriteTrustProbeResponseSchema>;
export type HubDesktopBootstrap = z.infer<typeof HubDesktopBootstrapSchema>;
export type HubConfig = z.infer<typeof HubConfigSchema>;
export type HubConfigResolved = z.infer<typeof HubConfigResolvedSchema>;
export type HubServerRuntime = z.infer<typeof HubServerRuntimeSchema>;
export type HubConfigResponse = z.infer<typeof HubConfigResponseSchema>;
export type { PublicRelayTargetSettings };

export interface HubConfigUpdatePayload {
  maxBatchTasks: number | undefined;
  expandInlineParamsOnStartup: boolean | undefined;
  /** 设为 null 表示取消默认（与「本次不改」区分：不改时不带该字段） */
  agentDefaultModelId: string | null | undefined;
  /** 生成形态的默认模型；设为 null 表示取消默认（与「本次不改」区分：不改时不带该字段） */
  generationDefaultModelId: string | null | undefined;
  proxyMode: ProxyMode | undefined;
  proxyUrl: string | undefined;
  /**
   * 用户自带的公共中转端点。undefined = 本次不改；提供对象 = 整体替换两个中转类型
   * （两个类型都必须给，endpoint 空串 = 清除该类型配置；非法 URL 由后端 400 拒绝）。
   */
  publicRelayTargets: PublicRelayTargetSettings | undefined;
}

export const HubUnknownResponseSchema = z.unknown();

export const HubTaskSummaryItemSchema = z.object({
  taskId: z.string(),
  id: z.string(),
  projectPath: z.string().nullable(),
  nodeGraphId: z.string().nullable(),
  sourceNodeId: z.string().nullable(),
  targetNodeId: z.string().nullable(),
  executionId: z.string().nullable(),
  modelId: z.string().nullable(),
  remoteRequestId: z.string().nullable(),
  status: UnifiedGenerationStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  errorMessage: z.string().nullable(),
  /** 生成进度百分比（任务行 progressPercent 投影）；任务行未写入进度时为 null。 */
  progress: z.number().nullable(),
});

export const HubTaskListResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  tasks: z.array(HubTaskSummaryItemSchema),
});

export type HubTaskSummaryItem = z.infer<typeof HubTaskSummaryItemSchema> & {
  status: UnifiedGenerationStatus;
};

export type HubTaskListResponse = z.infer<typeof HubTaskListResponseSchema>;
