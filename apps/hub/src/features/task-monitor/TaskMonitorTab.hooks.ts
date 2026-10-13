import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TaskStateNotificationSchema,
  UNIFIED_GENERATION_RUNNING_STATUSES,
  UNIFIED_GENERATION_STATUSES,
} from '@iart/contracts';
import type { RuntimeTaskView } from '@iart/contracts';
import { useHubRuntime } from '../../components/providers/HubAppProvider';
import { useHubStore } from '../../client/store/hub-store';
import type { TaskSummaryItem } from '../../client/types';
import { useProjects } from '../projects/ProjectsTab.hooks';

export type TaskStatus = TaskSummaryItem['status'];

/** 状态中文标签（等价 vanilla task-monitor-controller STATUS_LABEL） */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  submitting: '提交中',
  generating: '生成中',
  polling: '等待结果',
  downloading: '下载中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const ALL_STATUSES: TaskStatus[] = [...UNIFIED_GENERATION_STATUSES];

export const RUNNING_STATUSES = new Set<TaskStatus>(UNIFIED_GENERATION_RUNNING_STATUSES);

export interface TaskProgress {
  percent: number | undefined;
  message: string | undefined;
}

/** 运行时视图输入（等价 vanilla task-monitor-controller RuntimeViewInput） */
type RuntimeViewInput =
  | { type: 'baseline'; tasks: TaskSummaryItem[] }
  | { type: 'delta'; task: TaskSummaryItem; progress: TaskProgress | undefined };

const readStringField = (source: Record<string, unknown> | null | undefined, key: string): string | null => {
  const value: unknown = source ? source[key] : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/** 运行时任务视图 → 列表摘要项（等价 vanilla toTaskSummaryItem） */
const toTaskSummaryItem = (task: RuntimeTaskView): TaskSummaryItem => {
  const metadata: Record<string, unknown> | null = task.metadata ?? null;
  return {
    taskId: task.taskId,
    id: task.taskId,
    projectPath: task.projectPath || null,
    nodeGraphId: readStringField(metadata, 'nodeGraphId'),
    sourceNodeId: task.sourceNodeId ?? null,
    targetNodeId: task.targetNodeId ?? null,
    executionId: readStringField(metadata, 'executionId'),
    modelId: readStringField(metadata, 'modelId'),
    remoteRequestId: task.remoteRequestId ?? null,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    errorMessage: task.errorMessage ?? null,
    progress: task.progressPercent ?? null,
  };
};

/** 增量通知中的进度提取（percent/message 均未携带时返回 undefined） */
const toProgress = (task: RuntimeTaskView): TaskProgress | undefined => {
  if (task.progressPercent == null && task.progressMessage == null) return undefined;
  return {
    percent: task.progressPercent ?? undefined,
    message: task.progressMessage ?? undefined,
  };
};

/**
 * task-monitor 域 React 版操作 hook。逻辑与 vanilla 侧 createTaskMonitorController
 * （controllers/task-monitor-controller.ts）等价：
 * - 项目列表复用 hub-store projects.list（下拉框数据源），tab 激活时触发 loadProjects 刷新；
 * - 任务列表/过滤/进度缓存为组件内 state（只在本 tab 消费，不入全局 hub-store）；
 * - IPC task:state-changed 增量更新通过 platform.onTaskStateChanged 订阅，
 *   useEffect 注册、卸载时 removeTaskStateListeners 清理。
 */
export function useTaskMonitor() {
  const { taskMonitorFeature, platform } = useHubRuntime();
  const { loadProjects } = useProjects();
  const projects = useHubStore((s) => s.projects.list);
  const storeCurrentProjectPath = useHubStore((s) => s.projects.currentProjectPath);
  const setCurrentProjectPath = useHubStore((s) => s.setCurrentProjectPath);

  const [tasks, setTasks] = useState<TaskSummaryItem[]>([]);
  const [selectedProjectPath, setSelectedProjectPath] = useState('');
  const [activeFilter, setActiveFilter] = useState<TaskStatus | ''>('');
  const [statusMessage, setStatusMessage] = useState('请先选择一个项目');
  const [taskStatusMessage, setTaskStatusMessage] = useState('还没有任务');
  /** 列表加载三态：idle 正常 / loading 读取中 / error 最近一次读取失败（失败≠空，见 spec 交互流程） */
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');

  // 增量更新链路使用 ref 镜像，保证 IPC handler 与异步回调读到最新值
  const tasksRef = useRef<TaskSummaryItem[]>([]);
  const progressCacheRef = useRef<Map<string, TaskProgress>>(new Map());
  const selectedProjectPathRef = useRef('');
  const activeFilterRef = useRef<TaskStatus | ''>('');
  const abortControllerRef = useRef<AbortController | null>(null);

  /** 提交任务列表：写 ref + state，并同步任务状态栏文案（等价 vanilla renderTasks 的 taskStatus 分支） */
  const commitTasks = useCallback((next: TaskSummaryItem[]): void => {
    tasksRef.current = next;
    setTasks(next);
    setTaskStatusMessage(next.length === 0 ? '还没有任务' : `共 ${next.length} 条任务`);
  }, []);

  /** 运行时视图输入应用（baseline 全量替换；delta 按 activeFilter 增量合并，等价 vanilla applyRuntimeViewInput） */
  const applyRuntimeViewInput = useCallback(
    (input: RuntimeViewInput): void => {
      if (input.type === 'baseline') {
        progressCacheRef.current.clear();
        commitTasks(input.tasks);
        return;
      }

      const task = input.task;
      if (input.progress) progressCacheRef.current.set(task.taskId, input.progress);

      const current = tasksRef.current;
      const idx = current.findIndex((item) => item.taskId === task.taskId);

      if (activeFilterRef.current && activeFilterRef.current !== task.status) {
        if (idx >= 0) commitTasks(current.filter((item) => item.taskId !== task.taskId));
        if (!RUNNING_STATUSES.has(task.status)) progressCacheRef.current.delete(task.taskId);
        return;
      }

      let next: TaskSummaryItem[];
      if (idx >= 0) {
        const existing = current[idx];
        if (existing === undefined) {
          console.debug('[task-monitor] delta task index miss (concurrent reset), skip:', task.taskId);
          return;
        }
        next = current.map((item, index) => {
          if (index !== idx) return item;
          return {
            ...existing,
            ...task,
            errorMessage: task.errorMessage ?? existing.errorMessage,
            modelId: task.modelId ?? existing.modelId,
          };
        });
      } else {
        next = [task, ...current];
      }

      if (!RUNNING_STATUSES.has(task.status)) progressCacheRef.current.delete(task.taskId);
      commitTasks(next);
    },
    [commitTasks],
  );

  /** 清空任务列表与进度缓存（切项目 / 未选项目时回到引导态） */
  const clearTasks = useCallback((): void => {
    progressCacheRef.current.clear();
    commitTasks([]);
  }, [commitTasks]);

  /** 加载任务列表（等价 vanilla loadTasks；projectPath 为空时清空列表回到引导态） */
  const loadTasksFor = useCallback(
    async (projectPath: string, filter: TaskStatus | ''): Promise<void> => {
      if (!projectPath) {
        console.debug('[task-monitor] loadTasks skip: 未选择项目');
        setLoadState('idle');
        setStatusMessage('请先选择一个项目');
        clearTasks();
        return;
      }

      setStatusMessage('正在读取任务列表...');
      setLoadState('loading');

      if (abortControllerRef.current !== null) abortControllerRef.current.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const result = await taskMonitorFeature.loadTasks(
          {
            projectPath,
            status: filter || undefined,
            limit: undefined,
            offset: undefined,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setLoadState('idle');
        progressCacheRef.current.clear();
        commitTasks(result.tasks);
        setStatusMessage(`共 ${result.total} 条任务`);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('[task-monitor] loadTasks failed:', err);
        // 失败≠空：保留已有列表内容供用户继续查看，只把错误态与错误文案暴露出来
        setLoadState('error');
        setStatusMessage('没能读取任务列表，请点「刷新」重试');
      }
    },
    [clearTasks, commitTasks, taskMonitorFeature],
  );

  /** 刷新当前选中项目任务列表 */
  const loadTasks = useCallback((): Promise<void> => {
    return loadTasksFor(selectedProjectPathRef.current, activeFilterRef.current);
  }, [loadTasksFor]);

  /** 项目选择变更（等价 vanilla monitorProjectSelect change：重置过滤与进度缓存后重新加载） */
  const selectProject = useCallback(
    (path: string): void => {
      selectedProjectPathRef.current = path;
      setSelectedProjectPath(path);
      if (path) setCurrentProjectPath(path);
      activeFilterRef.current = '';
      setActiveFilter('');
      // 切项目清残留：上一项目的列表不得短暂串台到下一项目
      clearTasks();
      void loadTasksFor(path, '');
    },
    [clearTasks, loadTasksFor, setCurrentProjectPath],
  );

  /** 状态过滤（等价 vanilla onFilterChanged：切换过滤并携带 status 重新请求） */
  const filterTasks = useCallback(
    (filterStatus: TaskStatus | ''): void => {
      activeFilterRef.current = filterStatus;
      setActiveFilter(filterStatus);
      void loadTasksFor(selectedProjectPathRef.current, filterStatus);
    },
    [loadTasksFor],
  );

  /** IPC task:state-changed 增量处理（等价 vanilla handleTaskStateChanged） */
  const handleTaskStateChanged = useCallback(
    (message: unknown): void => {
      const parsed = TaskStateNotificationSchema.safeParse(message);
      if (!parsed.success) {
        console.warn('[task-monitor] invalid task:state-changed message');
        return;
      }
      const msg = parsed.data;

      const currentProject = selectedProjectPathRef.current;
      if (currentProject && msg.projectPath !== currentProject) {
        console.debug('[task-monitor] skip task:state-changed for other project:', msg.projectPath);
        return;
      }

      applyRuntimeViewInput({
        type: 'delta',
        task: toTaskSummaryItem(msg.task),
        progress: toProgress(msg.task),
      });
    },
    [applyRuntimeViewInput],
  );

  /** 注册 task:state-changed 订阅（卸载时由调用方 removeTaskStateListeners 清理） */
  const subscribeTaskEvents = useCallback((): void => {
    platform.onTaskStateChanged(handleTaskStateChanged);
  }, [handleTaskStateChanged, platform]);

  // 订阅 IPC：挂载注册、卸载清理（platform 无单回调退订 API，removeTaskStateListeners
  // 清理的是 Hub 渲染进程侧全部 task 通道监听；React Hub 中仅本 tab 消费 task 事件）
  useEffect(() => {
    subscribeTaskEvents();
    return () => {
      platform.removeTaskStateListeners();
    };
  }, [platform, subscribeTaskEvents]);

  // 卸载时中止进行中的请求，避免卸载后 setState
  useEffect(() => {
    return () => {
      if (abortControllerRef.current !== null) abortControllerRef.current.abort();
    };
  }, []);

  // tab 激活时刷新项目列表（等价 vanilla onMonitorTabActivated → loadProjects）
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // 项目列表/存储当前路径变化时校验下拉框选中态：
  // 选中值失效或为空时回落到 store 的 currentProjectPath（等价 vanilla populateProjectSelect 的默认选中）
  useEffect(() => {
    const current = selectedProjectPathRef.current;
    if (current && projects.some((project) => project.path === current)) return;
    if (storeCurrentProjectPath && projects.some((project) => project.path === storeCurrentProjectPath)) {
      selectedProjectPathRef.current = storeCurrentProjectPath;
      setSelectedProjectPath(storeCurrentProjectPath);
      void loadTasksFor(storeCurrentProjectPath, activeFilterRef.current);
    }
  }, [loadTasksFor, projects, storeCurrentProjectPath]);

  return {
    tasks,
    loadState,
    progressCache: progressCacheRef.current,
    selectedProjectPath,
    activeFilter,
    statusMessage,
    taskStatusMessage,
    projects,
    loadProjects,
    loadTasks,
    selectProject,
    filterTasks,
    subscribeTaskEvents,
  };
}
