/**
 * RightWorkspace Store — 右侧工作区容器状态
 *
 * spec「右侧工作区与打包区服务」：
 * - 无内容打开时完全收起（width:0、不留把手列）
 * - 单内容互斥：同一时刻最多一个内容种类，打开新内容时旧内容自动关闭
 * - 宽度按内容种类独立持久化（localStorage `iarts.editor.rightWorkspace.width.{kind}`）
 * - 默认 420px，可拖 360–560px（硬边界）
 * - 关闭不记忆上一个内容；再触同入口 / 关闭钮 / Esc 关闭
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { Draft } from 'immer';

/** 右侧工作区内容种类。当前正式内容：打包区、Agent 会话视图。 */
export type RightWorkspaceKind = 'packageArea' | 'agentSession';

export const RIGHT_WORKSPACE_WIDTH_DEFAULT = 420;
export const RIGHT_WORKSPACE_WIDTH_MIN = 360;
export const RIGHT_WORKSPACE_WIDTH_MAX = 560;

const WIDTH_STORAGE_KEY_PREFIX = 'iarts.editor.rightWorkspace.width';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const readStoredWidth = (kind: RightWorkspaceKind): number => {
  if (typeof window === 'undefined') return RIGHT_WORKSPACE_WIDTH_DEFAULT;
  try {
    const raw = window.localStorage.getItem(`${WIDTH_STORAGE_KEY_PREFIX}.${kind}`);
    if (raw === null || raw.trim().length === 0) return RIGHT_WORKSPACE_WIDTH_DEFAULT;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return RIGHT_WORKSPACE_WIDTH_DEFAULT;
    return clamp(parsed, RIGHT_WORKSPACE_WIDTH_MIN, RIGHT_WORKSPACE_WIDTH_MAX);
  } catch {
    return RIGHT_WORKSPACE_WIDTH_DEFAULT;
  }
};

const writeStoredWidth = (kind: RightWorkspaceKind, value: number): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${WIDTH_STORAGE_KEY_PREFIX}.${kind}`, String(value));
  } catch {
    // 隐私模式 / 存储异常：宽度持久化失败不阻断面板使用，回退内存态。
  }
};

type RightWorkspaceState = {
  /** 当前打开的内容种类；null 为完全收起 */
  activeKind: RightWorkspaceKind | null;
  /** 当前打开的 Agent 会话（仅 `activeKind === 'agentSession'` 时有值） */
  agentSessionId: string | null;
  /** 当前面板宽度（打开态；收起时保留最近值，用于关闭后写回） */
  width: number;
};

type RightWorkspaceActions = {
  /** 打开指定内容种类（互斥：打开新内容时旧内容自动关闭；会话视图请用 openSessionView） */
  open: (kind: RightWorkspaceKind) => void;
  /** 打开某会话的会话视图（一次性写入种类与会话，避免出现「开了面板但还不知道看哪段对话」的中间态） */
  openSessionView: (agentSessionId: string) => void;
  /** 再触同入口语义：同一内容打开则关闭，否则切换 */
  toggle: (kind: RightWorkspaceKind) => void;
  /** 关闭（不记忆上一个内容） */
  close: () => void;
  /** 拖拽中更新宽度（打开态才允许） */
  setWidth: (width: number) => void;
  /** 拖拽结束持久化当前宽度 */
  commitWidth: () => void;
};

export type RightWorkspaceStore = RightWorkspaceState & RightWorkspaceActions;

/**
 * 打开内容的共享实现（互斥：换内容时按旧种类命名空间写回宽度；宽度按目标种类读取）。
 * `agentSessionId` 只在会话视图这一种类上有意义，其他种类一律清空，避免留下陈旧会话引用。
 */
const applyOpen = (
  state: Draft<RightWorkspaceState>,
  kind: RightWorkspaceKind,
  agentSessionId: string | null,
): void => {
  if (state.activeKind !== null && state.activeKind !== kind) {
    writeStoredWidth(state.activeKind, state.width);
  }
  state.activeKind = kind;
  state.agentSessionId = kind === 'agentSession' ? agentSessionId : null;
  state.width = readStoredWidth(kind);
};

export const useRightWorkspaceStore = create<RightWorkspaceStore>()(
  subscribeWithSelector(
    immer((set, get) => ({
      activeKind: null,
      agentSessionId: null,
      width: RIGHT_WORKSPACE_WIDTH_DEFAULT,

      open: (kind) => {
        set((state) => {
          applyOpen(state, kind, null);
        });
      },

      openSessionView: (agentSessionId) => {
        set((state) => {
          applyOpen(state, 'agentSession', agentSessionId);
        });
      },

      toggle: (kind) => {
        const current = get().activeKind;
        if (current === kind) {
          get().close();
          return;
        }
        get().open(kind);
      },

      close: () => {
        set((state) => {
          // 关闭前写回当前宽度（按离开的种类命名空间）。
          const current = state.activeKind;
          if (current !== null) {
            writeStoredWidth(current, state.width);
          }
          state.activeKind = null;
          state.agentSessionId = null;
        });
      },

      setWidth: (width) => {
        set((state) => {
          state.width = clamp(width, RIGHT_WORKSPACE_WIDTH_MIN, RIGHT_WORKSPACE_WIDTH_MAX);
        });
      },

      commitWidth: () => {
        const { activeKind, width } = get();
        if (activeKind === null) return;
        writeStoredWidth(activeKind, width);
      },
    })),
  ),
);

export { readStoredWidth as readRightWorkspaceStoredWidth };

// ────────────────────────────────────────────
// Agent 会话视图入口（选中驱动进入 / 首次提交 / 右键菜单「展开 / 收起」的调用面，
// spec 02「会话视图与多轮历史」、06「历史承载与会话视图」）
// ────────────────────────────────────────────

/**
 * 在右侧工作区打开某会话的会话视图（互斥：打开它时打包区自动关闭）。
 * 只改容器状态，不触碰画布：打开/关闭不得移动画布 viewport 或兄弟节点。
 * 该会话视图已在展示时幂等早返回（spec 06「进入」）：重击已选中节点、续作提交等
 * 重复触发不得重置宽度与会话指针。
 */
export function openAgentSessionView(agentSessionId: string): void {
  if (!agentSessionId) {
    console.debug('[rightWorkspace] open agent session view skipped: empty session id');
    return;
  }
  const state = useRightWorkspaceStore.getState();
  if (state.activeKind === 'agentSession' && state.agentSessionId === agentSessionId) {
    console.debug('[rightWorkspace] open agent session view skipped: already showing session', {
      agentSessionId,
    });
    return;
  }
  state.openSessionView(agentSessionId);
}

/**
 * 再触同入口语义：同一会话的视图已打开则关闭，否则打开该会话的视图。
 * 这是 Agent 节点右键菜单「展开 / 收起」的实现（spec 06「历史承载与会话视图」；
 * Agent 节点选中工具栏不设会话视图开关）。
 */
export function toggleAgentSessionView(agentSessionId: string): void {
  if (!agentSessionId) {
    console.debug('[rightWorkspace] toggle agent session view skipped: empty session id');
    return;
  }
  const state = useRightWorkspaceStore.getState();
  if (state.activeKind === 'agentSession' && state.agentSessionId === agentSessionId) {
    state.close();
    return;
  }
  openAgentSessionView(agentSessionId);
}
