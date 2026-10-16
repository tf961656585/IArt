/**
 * CLI 代理执行通道 · 错误响应与载荷读取助手（spec docs/integrations/CLI与本地Agent集成.md §9）。
 *
 * 从 cliProxyReceiver.ts 拆出的职责边界：错误响应构造（message 面向使用 CLI 的开发者，
 * 用户视角业务语言，不暴露内部术语）、载荷字符串字段读取与 Backend 拒绝理由提取。
 * 纯函数、无 store 依赖；命令执行映射逻辑仍在 cliProxyReceiver.ts。
 */
import type { CliErrorCode, CliProxyCommand, CliProxyCommandError } from '@iart/contracts';

// ---------------------------------------------------------------------------
// 错误响应构造（spec §9：message 面向使用 CLI 的开发者，用户视角业务语言，不暴露内部术语）
// ---------------------------------------------------------------------------

export const buildErrorResponse = (
  commandName: CliProxyCommand['command'],
  requestId: string,
  code: CliErrorCode,
  message: string,
): CliProxyCommandError => ({
  command: commandName,
  request_id: requestId,
  error: { code, message },
});

/** 从 unknown 记录读取一个字符串字段（不命中返回 null）。 */
export const readRecordStringField = (value: unknown, key: string): string | null => {
  if (typeof value !== 'object' || value === null) return null;
  const field: unknown = Reflect.get(value, key);
  return typeof field === 'string' && field.length > 0 ? field : null;
};

/** 把 HTTP 错误体（{code, message}）里的 Backend 理由取出，缺失时回退到 transport 消息。 */
export const readBackendRejectionDetail = (body: unknown, fallback: string): string => {
  const message = readRecordStringField(body, 'message');
  return message ?? fallback;
};
