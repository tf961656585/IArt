import type { HubApiClient, TaskListResponse, TaskSummaryItem } from '../types';

export const createTaskMonitorFeature = (api: HubApiClient) => ({
  loadTasks(params: { projectPath: string; status: TaskSummaryItem['status'] | undefined; limit: number | undefined; offset: number | undefined }, signal: AbortSignal | undefined): Promise<TaskListResponse> {
    return api.loadTasks(params, signal);
  },
});
