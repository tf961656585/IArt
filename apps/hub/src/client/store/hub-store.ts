import { create } from 'zustand';
import type { ProjectIndexItem } from '@iart/contracts';

/** projects 列表项（契约口径：StorageListProjectsResult.projects 元素） */
type ProjectItem = ProjectIndexItem;

interface HubState {
  bootstrapStatus: 'loading' | 'ready' | 'fatal-error';
  currentTab: string;
  auth: {
    status: 'loading' | 'done' | 'error';
    authenticated: boolean;
    label: string;
    userId: string;
    /** 余额展示文本（如 '$3.20'）；'' 表示未加载（未登录或加载失败） */
    balance: string;
    balanceLoading: boolean;
  };
  projects: {
    list: ProjectItem[];
    loading: boolean;
    error: string | null;
    currentProjectPath: string;
    openedProjectPaths: string[];
  };
  // 后续域迁移时扩充 settings 等
  setBootstrapStatus: (s: HubState['bootstrapStatus']) => void;
  setCurrentTab: (t: string) => void;
  setAuth: (a: Partial<HubState['auth']>) => void;
  setAuthBalance: (balance: string) => void;
  setAuthBalanceLoading: (loading: boolean) => void;
  setProjects: (list: ProjectItem[]) => void;
  setProjectsLoading: (loading: boolean) => void;
  setProjectsError: (error: string | null) => void;
  /** 当前项目路径（任务监控下拉框选中态落点，等价 vanilla 控制器 state.currentProjectPath） */
  setCurrentProjectPath: (path: string) => void;
}

export const useHubStore = create<HubState>((set) => ({
  bootstrapStatus: 'ready', // main.tsx bootstrap 成功后才 render，所以进 App 时已是 ready
  currentTab: 'canvas',
  auth: { status: 'loading', authenticated: false, label: '', userId: '', balance: '', balanceLoading: false },
  projects: {
    list: [],
    loading: false,
    error: null,
    currentProjectPath: '',
    openedProjectPaths: [],
  },
  setBootstrapStatus: (s) => set({ bootstrapStatus: s }),
  setCurrentTab: (t) => set({ currentTab: t }),
  setAuth: (a) => set((s) => ({ auth: { ...s.auth, ...a } })),
  setAuthBalance: (balance) => set((s) => ({ auth: { ...s.auth, balance } })),
  setAuthBalanceLoading: (loading) => set((s) => ({ auth: { ...s.auth, balanceLoading: loading } })),
  setProjects: (list) => set((s) => ({ projects: { ...s.projects, list } })),
  setProjectsLoading: (loading) => set((s) => ({ projects: { ...s.projects, loading } })),
  setProjectsError: (error) => set((s) => ({ projects: { ...s.projects, error } })),
  setCurrentProjectPath: (currentProjectPath) => set((s) => ({ projects: { ...s.projects, currentProjectPath } })),
}));
