import type { NodeTaskInfo } from '../types';

export type CanvasTaskStatus = NonNullable<NodeTaskInfo['status']>;

type BadgeIcon = 'check' | 'x';

/**
 * 状态色经 globals.css 令牌消费（docs/editor/visual-design.md §5.5 六态三档）：
 * - dot：白 pill 内状态点（--task-dot-*，浅色 600 档恒定，白底 ≥3:1）。
 * - text：白 pill 徽章文字（--task-badge-text-*，700 档恒定，白底 ≥4.5:1）。
 * 禁止 Tailwind 色类硬编码（spec §9 禁止项）。
 */
export type CanvasTaskStatusMeta = {
  label: string;
  /** 内容节点居中遮罩文案（仅用于进行中状态） */
  overlayText: string | undefined;
  badge: {
    textVar: string;
    dotVar: string | undefined;
    pingVar: string | undefined;
    icon: BadgeIcon | undefined;
    active: boolean | undefined;
  };
};

export const TASK_STATUS_META = {
  submitting: {
    label: '提交中',
    overlayText: '提交中...',
    badge: {
      dotVar: 'var(--task-dot-submitting)',
      textVar: 'var(--task-badge-text-submitting)',
      pingVar: 'var(--task-dot-submitting)',
      icon: undefined,
      active: true,
    },
  },
  generating: {
    label: '生成中',
    overlayText: '生成中...',
    badge: {
      dotVar: 'var(--task-dot-generating)',
      textVar: 'var(--task-badge-text-generating)',
      pingVar: 'var(--task-dot-generating)',
      icon: undefined,
      active: true,
    },
  },
  downloading: {
    label: '下载中',
    overlayText: '下载中...',
    badge: {
      dotVar: 'var(--task-dot-downloading)',
      textVar: 'var(--task-badge-text-downloading)',
      pingVar: 'var(--task-dot-downloading)',
      icon: undefined,
      active: true,
    },
  },
  polling: {
    label: '等待结果',
    overlayText: '等待结果...',
    badge: {
      dotVar: 'var(--task-dot-polling)',
      textVar: 'var(--task-badge-text-polling)',
      pingVar: 'var(--task-dot-polling)',
      icon: undefined,
      active: true,
    },
  },
  succeeded: {
    label: '已完成',
    overlayText: undefined,
    badge: {
      textVar: 'var(--st-succeeded)',
      dotVar: undefined,
      pingVar: undefined,
      icon: 'check',
      active: false,
    },
  },
  failed: {
    label: '失败',
    overlayText: undefined,
    badge: {
      textVar: 'var(--task-badge-text-failed)',
      dotVar: undefined,
      pingVar: undefined,
      icon: 'x',
      active: false,
    },
  },
  cancelled: {
    label: '已取消',
    overlayText: undefined,
    badge: {
      textVar: 'var(--task-badge-text-cancelled)',
      dotVar: undefined,
      pingVar: undefined,
      icon: undefined,
      active: false,
    },
  },
} satisfies Record<CanvasTaskStatus, CanvasTaskStatusMeta>;

const TASK_STATUS_META_BY_STATUS: Record<CanvasTaskStatus, CanvasTaskStatusMeta> = TASK_STATUS_META;

export const normalizeCanvasTaskStatus = (status: string | null | undefined): CanvasTaskStatus | null => {
  if (typeof status !== 'string') return null;
  const normalized = status.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized in TASK_STATUS_META_BY_STATUS) {
    return normalized as CanvasTaskStatus;
  }
  return null;
};

const normalizeTaskPhase = (phase: string | null | undefined): string | null => {
  if (typeof phase !== 'string') return null;
  const normalized = phase.trim().toLowerCase();
  return normalized || null;
};

/**
 * submitting 状态下按 progressPhase 细分的文案覆盖（status + phase -> 文案映射）。
 * 徽标、节点遮罩共用同一映射表。
 */
const SUBMITTING_PHASE_OVERRIDES: Record<string, { label: string; overlayText: string }> = {
  uploading_input: { label: '上传图像中', overlayText: '上传图像中...' },
};

export const resolveTaskStatusMeta = (
  status: string | null | undefined,
  phase: string | null | undefined,
): CanvasTaskStatusMeta | null => {
  const normalized = normalizeCanvasTaskStatus(status);
  if (!normalized) return null;
  if (normalized === 'submitting') {
    const override = SUBMITTING_PHASE_OVERRIDES[normalizeTaskPhase(phase) ?? ''];
    if (override) {
      const base = TASK_STATUS_META.submitting;
      if (!base) return null;
      return {
        ...base,
        label: override.label,
        overlayText: override.overlayText,
      };
    }
  }
  return TASK_STATUS_META_BY_STATUS[normalized] ?? null;
};

export const getTaskStatusLabel = (status: string | null | undefined, phase: string | null | undefined): string | null => {
  const meta = resolveTaskStatusMeta(status, phase);
  return meta !== null ? meta.label : null;
};

export const getTaskStatusOverlayText = (status: string | null | undefined, phase: string | null | undefined): string | null => {
  const meta = resolveTaskStatusMeta(status, phase);
  return meta !== null ? meta.overlayText ?? null : null;
};
