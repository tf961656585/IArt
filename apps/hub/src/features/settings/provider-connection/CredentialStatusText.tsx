import type { CredentialDisplay } from './credentialDisplay';
import { StatusDot } from './StatusDot';

/**
 * 密钥状态词的呈现（详情头第二行与列表卡片共用）。
 *
 * - 读不出来（`needs_reentry`）：复用 StatusDot 的「点 + 文字」，异常色走既有语义令牌；
 * - 其余情况：纯文本——密钥不用胶囊徽章，也不参与服务商的状态色
 *   （`docs/ui-copy-standard.md` 第 9 条）。
 */
export function CredentialStatusText({ credential }: { credential: CredentialDisplay }) {
  if (credential.needsReentry) return <StatusDot tone="bad" label={credential.text} />;
  return <span className="shrink-0 whitespace-nowrap">{credential.text}</span>;
}
