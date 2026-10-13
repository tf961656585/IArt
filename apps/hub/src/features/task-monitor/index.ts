import type { HubApiClient, TaskListResponse, TaskSummaryItem } from '../../client/types';

export { TaskMonitorTab } from './TaskMonitorTab';
export { useTaskMonitor } from './TaskMonitorTab.hooks';

export const createTaskMonitorFeature = (api: HubApiClient) => ({
  loadTasks(params: { projectPath: string; status: TaskSummaryItem['status'] | undefined; limit: number | undefined; offset: number | undefined }, signal: AbortSignal | undefined): Promise<TaskListResponse> {
    return api.loadTasks(params, signal);
  },
});
