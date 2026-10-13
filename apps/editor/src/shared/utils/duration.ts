/**
 * 时长展示共享工具（编辑器层唯一版本）。
 *
 * 口径：毫秒 → `m:ss`（原型 ref-dur / AssetNode hoverMeta / 媒体时长角标同口径）；
 * 未知或非正时长返回 null，由消费方决定占位文案（媒体卡角标不渲染、
 * 音频条显示「--:--」），不在工具里替消费方写死占位符。
 */
export function formatDuration(durationMs: number | null | undefined): string | null {
  if (typeof durationMs !== 'number' || durationMs <= 0) return null;
  const totalSeconds = Math.round(durationMs / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
