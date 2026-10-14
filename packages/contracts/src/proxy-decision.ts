import * as z from 'zod';

/**
 * 生效代理决策（spec docs/runtime/远端请求执行治理原则.md「代理治理」）。
 *
 * 软件内代理设置的唯一代理解析 owner 是 Runtime Backend：backend 归一化三档
 * （system / manual / direct）后产发本决策，经 fork IPC 推送主进程；主进程只消费
 * 生效决策，不读原始代理配置，归一化规则由 backend 独家持有。
 *
 * system 档的 `resolved` 是系统代理检测快照（backend 自身出站按同一快照建
 * dispatcher；主进程留痕与诊断消费，不作为行为依据——窗口与更新器 session 在
 * 该档走 Chromium 原生跟随，支持动态变化与 PAC）。
 */
export const EffectiveProxyDecisionSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('direct'),
  }),
  z.object({
    mode: z.literal('manual'),
    proxyUrl: z.string().min(1),
  }),
  z.object({
    mode: z.literal('system'),
    resolved: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('none') }),
      z.object({ kind: z.literal('proxy'), proxyUrl: z.string().min(1) }),
    ]),
  }),
]);

export type EffectiveProxyDecision = z.infer<typeof EffectiveProxyDecisionSchema>;

/**
 * Backend → Main 通知：生效代理决策变化（backend 就绪 / 设置变更保存 / 窗口聚焦
 * 触发重新解析后检出变化）。与 task:state-changed 同类的 fire-and-forget 通知。
 */
export const ProxyDecisionNotificationSchema = z.object({
  type: z.literal('proxy:decision-changed'),
  decision: EffectiveProxyDecisionSchema,
});

export type ProxyDecisionNotification = z.infer<typeof ProxyDecisionNotificationSchema>;

/**
 * Main → Backend 请求：窗口聚焦触发重新解析（跟随系统档保鲜触发点）。
 * fire-and-forget；backend 重新解析后检出变化才推送新决策。
 */
export const ProxyRefreshRequestSchema = z.object({
  type: z.literal('runtime:refresh-proxy'),
});

export type ProxyRefreshRequest = z.infer<typeof ProxyRefreshRequestSchema>;
