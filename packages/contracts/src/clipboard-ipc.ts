import * as z from 'zod';

/**
 * clipboard IPC channel 名集中管理。
 *
 * 与 reveal 类 IPC（`reveal-files-url` 等裸字符串散落三处）不同，clipboard 类 IPC 按
 * AGENTS.md 的 Zod 边界规范升级：channel 名 + 请求/响应 schema 统一进 contracts。
 *
 * 命名空间 `clipboard:` 与 `storage:` 对称，不复用 reveal 类的连字符模式。
 */
export const CLIPBOARD_IPC_CHANNELS = {
  WRITE_TEXT: 'clipboard:write-text',
  WRITE_IMAGE_FROM_URL: 'clipboard:write-image-from-url',
} as const;

export type ClipboardIpcChannel =
  (typeof CLIPBOARD_IPC_CHANNELS)[keyof typeof CLIPBOARD_IPC_CHANNELS];

// ---------------------------------------------------------------------------
// clipboard:write-text
// ---------------------------------------------------------------------------

export const ClipboardWriteTextFailureReasonSchema = z.enum([
  'not-in-browser',
  'not-in-electron',
  'empty-text',
  'write-failed',
  'invoke-failed',
]);

export const ClipboardWriteTextRequestSchema = z
  .object({
    text: z.string().min(1),
  })
  .strict();

export const ClipboardWriteTextResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: ClipboardWriteTextFailureReasonSchema,
    })
    .strict(),
]);

export type ClipboardWriteTextFailureReason = z.infer<
  typeof ClipboardWriteTextFailureReasonSchema
>;
export type ClipboardWriteTextRequest = z.infer<typeof ClipboardWriteTextRequestSchema>;
export type ClipboardWriteTextResponse = z.infer<typeof ClipboardWriteTextResponseSchema>;

// ---------------------------------------------------------------------------
// clipboard:write-image-from-url
// ---------------------------------------------------------------------------

/**
 * write-image-from-url 的失败 reason 集合。
 *
 * 与 revealFilesUrl 的 reason 集合对齐（同一套 URL 解析 + 安全校验链路），新增 nativeImage
 * 读取相关 reason（read-failed），以及 bridge 层衍生 reason（invoke-failed / not-in-electron）。
 */
export const ClipboardWriteImageFailureReasonSchema = z.enum([
  // 输入校验
  'missing-url',
  'missing-project-path',
  // URL 解析阶段
  'not-files-url',
  'resolve-failed',
  'invalid-file-key',
  'unsafe-file-key',
  // 路径解析阶段
  'missing-media-dir',
  'path-outside-media',
  // 文件读取阶段
  'not-found',
  'read-failed',
  // bridge / IPC 层
  'invoke-failed',
  'not-in-browser',
  'not-in-electron',
]);

export const ClipboardWriteImageRequestSchema = z
  .object({
    url: z.string().min(1),
    projectPath: z.string().nullable(),
  })
  .strict();

export const ClipboardWriteImageResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      filePath: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: ClipboardWriteImageFailureReasonSchema,
    })
    .strict(),
]);

export type ClipboardWriteImageFailureReason = z.infer<
  typeof ClipboardWriteImageFailureReasonSchema
>;
export type ClipboardWriteImageRequest = z.infer<typeof ClipboardWriteImageRequestSchema>;
export type ClipboardWriteImageResponse = z.infer<typeof ClipboardWriteImageResponseSchema>;
