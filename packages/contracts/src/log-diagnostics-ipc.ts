import * as z from 'zod';

/**
 * 日志诊断 IPC 契约：Hub 设置页「打开日志文件夹」（定位 backend 业务日志目录）。
 *
 * spec: docs/editor/本地文件快捷跳转.md（LFJ-008，登记表「Hub 设置『打开日志文件夹』」）。
 * backend.log 落存储根 logs/ 目录（docs/desktop-updates/排查日志-dev-与安装版分流.md），
 * 路径解析归主进程（与 reveal-updater-log 同模式：渲染层不自持路径）。
 */

export const LOG_DIAGNOSTICS_IPC_CHANNELS = {
  REVEAL_BACKEND_LOG_FOLDER: 'reveal-backend-log-folder',
} as const;

export type LogDiagnosticsIpcChannel =
  (typeof LOG_DIAGNOSTICS_IPC_CHANNELS)[keyof typeof LOG_DIAGNOSTICS_IPC_CHANNELS];

/** 结果形状与 AppUpdateRevealLogResultSchema 同构（success + 可选 path/error）。 */
export const RevealBackendLogFolderResultSchema = z
  .object({
    success: z.boolean(),
    path: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export type RevealBackendLogFolderResult = z.infer<typeof RevealBackendLogFolderResultSchema>;
