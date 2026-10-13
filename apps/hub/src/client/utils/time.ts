import type { AppUpdateProgress } from '@iart/contracts';

const BEIJING_TIMEZONE = 'Asia/Shanghai';

export function formatBytes(bytes: number): string {
  const normalizedBytes: number = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
  if (normalizedBytes <= 0) return '0 B';

  const kiloBytesBase: number = 1024;
  const sizeUnits: string[] = ['B', 'KB', 'MB', 'GB'];
  const unitIndex: number = Math.floor(Math.log(normalizedBytes) / Math.log(kiloBytesBase));

  return parseFloat((normalizedBytes / Math.pow(kiloBytesBase, unitIndex)).toFixed(1)) + ' ' + sizeUnits[unitIndex];
}

export function formatDateTime(timestamp: number | null): string {
  const normalizedTimestamp: number = Number(timestamp);
  if (!Number.isFinite(normalizedTimestamp) || normalizedTimestamp <= 0) return '';

  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: BEIJING_TIMEZONE,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(normalizedTimestamp));
  } catch {
    return '';
  }
}

export function formatTime(timestamp: string | number | Date | null | undefined): string {
  if (!timestamp) return '-';

  try {
    return formatDateTime(new Date(timestamp).getTime());
  } catch {
    return String(timestamp);
  }
}

export function applyProgress(
  fillElement: HTMLElement | null,
  textElement: HTMLElement | null,
  progress: AppUpdateProgress | null,
): void {
  if (!fillElement || !textElement || !progress) return;
  const percent: number = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  fillElement.style.width = percent.toFixed(1) + '%';

  const speed: string = formatBytes(Number(progress.bytesPerSecond) || 0) + '/s';
  const transferred: string = formatBytes(Number(progress.transferred) || 0);
  const total: string = formatBytes(Number(progress.total) || 0);

  textElement.textContent = transferred + ' / ' + total + ' (' + speed + ')';
}
