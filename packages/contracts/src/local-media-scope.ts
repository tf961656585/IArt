import * as z from 'zod';

/**
 * local-media:// URL scope 段的合法集合（单一事实源）。
 *
 * scope 段即 `local-media://{scope}/{fileKey}` 的 hostname 部分，取值三选一：
 * - stableProjectId（V2, 前缀 `spid_`，24 hex）：新写入优先。
 * - projectRef（V1, 前缀 `prj_`，32 hex）：仅历史兼容。
 * - `__global__`：全局资产，不属于任何项目。
 *
 * 前缀正则与 `@iart/utils` 的 `isProjectRef` / `isStableProjectId` 谓词同源，
 * 修改任一处必须同步另一处（谓词是运行时判断，schema 是边界校验）。
 *
 * 注意：本 schema 是新代码消费 scope 时的严格校验入口。`EditorDesktopBootstrapSchema`
 * 等历史 schema 因 DB 读取路径与测试 fixture 尚未全部迁移到合规前缀，
 * 暂时保留宽松 `z.string().min(1)` 校验（见各字段旁注释）。
 * 迁移完成后的统一收紧触发条件：DB 读取路径（resolveStableProjectId / ensureStableProjectId）
 * 增加 isStableProjectId 守卫，且测试 fixture 全部使用合规前缀值。
 */
export const ProjectRefSchema = z.string().regex(/^prj_[a-f0-9]{32}$/);
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

export const StableProjectIdSchema = z.string().regex(/^spid_[a-f0-9]{24}$/);
export type StableProjectId = z.infer<typeof StableProjectIdSchema>;

export const GlobalScopeRefSchema = z.literal('__global__');
export type GlobalScopeRef = z.infer<typeof GlobalScopeRefSchema>;

/**
 * ScopeRef — scope 段的联合合法集合。
 *
 * 排序：V2（spid_）优先，其次 V1（prj_），最后 global。
 * 排序不影响校验语义，仅影响可读性。
 */
export const ScopeRefSchema = z.union([
  StableProjectIdSchema,
  ProjectRefSchema,
  GlobalScopeRefSchema,
]);
export type ScopeRef = z.infer<typeof ScopeRefSchema>;
