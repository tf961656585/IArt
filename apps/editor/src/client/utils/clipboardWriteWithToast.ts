import { toast } from 'sonner';
import type {
  ClipboardWriteImageResponse,
  ClipboardWriteTextResponse,
} from '@iart/contracts';
import type { SystemClipboardSyncResult } from '@/features/canvas/clipboard/systemClipboardSync';

/**
 * 把 systemClipboardSync 的结果转为用户可见反馈。
 *
 * 反馈策略（spec 决策 C）：
 * - 成功 → 静默，不 toast。
 * - skipped（多选跳过、不支持节点、视频/音频、无内容）→ 静默，不 toast。
 * - 失败 → 按 reason 分级 toast：
 *   - not-in-browser / not-in-electron：web 预览模式本就不支持，静默。
 *   - empty-text：内容为空是合理状态，静默。
 *   - 路径解析类（missing-url / not-files-url / resolve-failed / invalid-file-key）→ warning。
 *   - 安全校验类（unsafe-file-key / path-outside-media）→ error（安全信号需可见）。
 *   - 文件类（not-found / read-failed）→ warning / error。
 *   - bridge 层（write-failed / invoke-failed / missing-media-dir / missing-project-path）→ error。
 *
 * 不降级为 URL 文本（spec 禁止项）。
 */
export const reportSystemClipboardResult = (
  result: SystemClipboardSyncResult,
): void => {
  // 静默：skipped 或成功
  if (result.skipped) return;
  if (result.ok) return;

  // 失败：按 reason 分级
  const reason = result.reason;
  const message = resolveToastMessage(reason);
  if (message === null) return; // 静默类 reason

  if (message.level === 'warning') {
    toast.warning(message.text);
    return;
  }
  toast.error(message.text);
};

type ToastConfig = { level: 'warning' | 'error'; text: string };

/**
 * 把失败 reason 映射到 toast 配置。
 *
 * 返回 null 表示静默（不弹 toast）。
 * 覆盖 contracts 的全部 reason 集合（write-text 5 种 + write-image 13 种 = 18 种），
 * 避免遗漏导致 fallback 文案。
 */
const resolveToastConfig = (reason: string): ToastConfig | null => {
  switch (reason) {
    // 静默类
    case 'not-in-browser':
    case 'not-in-electron':
    case 'empty-text':
      return null;

    // 路径解析类（warning）
    case 'missing-url':
    case 'not-files-url':
    case 'resolve-failed':
    case 'invalid-file-key':
      return { level: 'warning', text: '没有找到要复制的文件。' };

    // 安全校验类（error：安全信号需可见）
    case 'unsafe-file-key':
    case 'path-outside-media':
      return { level: 'error', text: '这个文件的位置不在项目允许的范围内，已停止复制。' };

    // 文件类
    case 'not-found':
      return { level: 'warning', text: '要复制的文件不存在。' };
    case 'read-failed':
      return { level: 'error', text: '读取文件失败，请重试。' };

    // bridge / IPC 层（error）
    case 'write-failed':
    case 'invoke-failed':
    case 'missing-media-dir':
    case 'missing-project-path':
      return { level: 'error', text: '没能复制到剪贴板，请重试。' };

    default:
      // 兜底：未知 reason 不静默，给一个通用文案便于发现遗漏
      return { level: 'error', text: '没能复制到剪贴板，请重试。' };
  }
};

const resolveToastMessage = (reason: string): ToastConfig | null =>
  resolveToastConfig(reason);

// 类型导出（保留用于将来按响应类型做更精细处理的扩展点）
export type { ClipboardWriteTextResponse, ClipboardWriteImageResponse };
