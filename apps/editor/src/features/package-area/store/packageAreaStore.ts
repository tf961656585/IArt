/**
 * Package Area Store — 打包区状态管理
 *
 * 打包区是画布级独立创作对象，作为独立 zustand 域，不混入 canvasStore
 * （避免 canvasStore 职责膨胀）。store 消费 backendPackageArea 封装层，
 * 每次 mutation 后用服务端返回的 canonical 排序 PackageAreaView 替换 state。
 *
 * 项目打开时随项目加载触发 loadPackageArea（由 RightWorkspace 生命周期挂载）。
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { PackageAreaMutation, PackageAreaView } from '@iart/contracts';
import {
  applyPackageAreaMutation,
  readPackageAreaByGraphId,
} from '../storage/backendPackageArea';
import { getCurrentProjectPath } from '@/features/canvas/storage/backendCore';

type PackageAreaStoreState = {
  /** 当前画布的打包区（canonical 排序投影，含 isMissing 判定） */
  packageArea: PackageAreaView | null;
  /** 是否正在加载 */
  loading: boolean;
  /** 最近一次错误（如有），用于 UI 提示 */
  error: string | null;
};

type PackageAreaStoreActions = {
  /** 加载指定 graphId 的打包区（项目打开时触发） */
  loadPackageArea: (graphId: string) => Promise<void>;
  /**
   * 提交一条 mutation，成功后用服务端返回的 canonical PackageAreaView 替换 state。
   * 返回最新的 PackageAreaView（便于调用方链式处理）。
   */
  submitMutation: (
    graphId: string,
    mutation: PackageAreaMutation,
  ) => Promise<PackageAreaView | null>;
  /** 重置 store（项目关闭/切换时） */
  reset: () => void;
};

export type PackageAreaStore = PackageAreaStoreState & PackageAreaStoreActions;

const initialState: PackageAreaStoreState = {
  packageArea: null,
  loading: false,
  error: null,
};

const resolveProjectPath = async (): Promise<string | null> => {
  try {
    return await getCurrentProjectPath();
  } catch (err) {
    console.debug('[packageAreaStore] getCurrentProjectPath failed', err);
    return null;
  }
};

export const usePackageAreaStore = create<PackageAreaStore>()(
  subscribeWithSelector(
    immer((set) => ({
      ...initialState,

      loadPackageArea: async (graphId) => {
        if (!graphId) {
          console.debug('[packageAreaStore] loadPackageArea: empty graphId, skip');
          return;
        }
        set((state) => {
          state.loading = true;
          state.error = null;
        });
        try {
          const projectPath = await resolveProjectPath();
          if (projectPath === null) {
            console.debug('[packageAreaStore] loadPackageArea: no project path, abort');
            set((state) => {
              state.loading = false;
            });
            return;
          }
          const packageArea = await readPackageAreaByGraphId(projectPath, graphId);
          set((state) => {
            state.packageArea = packageArea;
            state.loading = false;
          });
        } catch (err) {
          console.error('[packageAreaStore] loadPackageArea failed', err);
          set((state) => {
            state.loading = false;
            state.error = err instanceof Error ? err.message : String(err);
          });
        }
      },

      submitMutation: async (graphId, mutation) => {
        const projectPath = await resolveProjectPath();
        if (projectPath === null) {
          console.debug('[packageAreaStore] submitMutation: no project path, abort');
          return null;
        }
        // 打包区尚无独立记录行：未加载时无需先取 id，直接提交（空打包区即零行）。
        try {
          const next = await applyPackageAreaMutation(projectPath, graphId, mutation);
          set((state) => {
            state.packageArea = next;
          });
          return next;
        } catch (err) {
          console.error('[packageAreaStore] submitMutation failed', err);
          set((state) => {
            state.error = err instanceof Error ? err.message : String(err);
          });
          return null;
        }
      },

      reset: () => {
        set((state) => {
          Object.assign(state, initialState);
        });
      },
    })),
  ),
);
