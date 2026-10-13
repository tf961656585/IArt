import * as z from 'zod';

/**
 * 定位（reveal）IPC 契约：Hub 项目目录 / 导出文件在系统文件管理器中的定位。
 *
 * spec: docs/editor/本地文件快捷跳转.md（登记表「Hub 项目卡『打开所在文件夹』」、
 * 「Hub 导出项目完成反馈」历史特例；存量裸字符串通道 Schema 化欠账条款）。
 *
 * `reveal-project-folder` 是存量裸字符串通道，本次改动顺带补齐 schema（spec §机制主链）：
 * 该通道同时服务目录类（项目目录，定位并高亮目录本身）与文件类（导出的 .iarts.zip，
 * 定位并高亮文件本身）两种语义——主进程 stat 两者皆可，shell.showItemInFolder 对
 * 文件高亮文件本身、对目录高亮目录本身。
 */

export const REVEAL_IPC_CHANNELS = {
  REVEAL_PROJECT_FOLDER: 'reveal-project-folder',
} as const;

export type RevealIpcChannel =
  (typeof REVEAL_IPC_CHANNELS)[keyof typeof REVEAL_IPC_CHANNELS];

export const RevealProjectFolderRequestSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();

export type RevealProjectFolderRequest = z.infer<typeof RevealProjectFolderRequestSchema>;

/**
 * 失败 reason 集合：
 * - not-in-browser / not-in-electron / invoke-failed：bridge 层运行环境与调用失败
 * - invalid-response：主进程返回无法通过 schema 校验
 * - not-absolute：主进程侧路径校验
 * - path-missing：目标不存在（文件或目录被移动/删除）
 */
export const RevealProjectFolderFailureReasonSchema = z.enum([
  'not-in-browser',
  'not-in-electron',
  'invoke-failed',
  'invalid-response',
  'not-absolute',
  'path-missing',
]);

export type RevealProjectFolderFailureReason = z.infer<
  typeof RevealProjectFolderFailureReasonSchema
>;

export const RevealProjectFolderResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: RevealProjectFolderFailureReasonSchema,
      path: z.string().optional(),
    })
    .strict(),
]);

export type RevealProjectFolderResult = z.infer<typeof RevealProjectFolderResultSchema>;
