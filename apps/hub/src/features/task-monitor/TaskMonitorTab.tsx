import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@iart/ui';
import { Activity, AlertCircle, Inbox, LayoutGrid, RefreshCw } from 'lucide-react';
import { useHubStore } from '../../client/store/hub-store';
import { TaskItem } from './TaskItem';
import { HubTopBand } from '../../components/HubTopBand';
import { ALL_STATUSES, STATUS_LABEL, useTaskMonitor, type TaskStatus } from './TaskMonitorTab.hooks';

/**
 * Radix Select 禁止空字符串 item value（空串用于清空选中显示 placeholder），
 * 用哨兵值表达“未选择项目”，等价 vanilla 原生 select 的 `-- 请选择项目 --` 选项。
 */
const NO_PROJECT_VALUE = '__no_project__';

const FILTER_OPTIONS: Array<{ value: TaskStatus | ''; label: string }> = [
  { value: '', label: '全部' },
  ...ALL_STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] })),
];

/**
 * 任务监控 tab：页面标题 + 项目选择 + 状态栏 + 过滤栏 + 任务列表 + 刷新 + 引导提示（无项目时）。
 * 逻辑与 vanilla createTaskMonitorController 等价；tab 挂载即激活
 * （loadProjects + 默认选中 + IPC 订阅 + 加载任务），卸载时清理订阅。
 */
export function TaskMonitorTab() {
  const {
    tasks,
    loadState,
    progressCache,
    selectedProjectPath,
    activeFilter,
    statusMessage,
    taskStatusMessage,
    projects,
    loadTasks,
    selectProject,
    filterTasks,
  } = useTaskMonitor();
  const setCurrentTab = useHubStore((s) => s.setCurrentTab);

  const selectValue: string = selectedProjectPath === '' ? NO_PROJECT_VALUE : selectedProjectPath;

  const handleSelectChange = (value: string): void => {
    selectProject(value === NO_PROJECT_VALUE ? '' : value);
  };

  return (
    <div className="flex h-full w-full flex-col">
      {/* 顶栏带（spec docs/hub/window-chrome.md §6.1/§6.3）：标题 + 副标题行内 */}
      <HubTopBand>
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-semibold">任务监控</h1>
          <span className="text-sm text-muted-foreground">查看每个项目里生成任务的进展与结果</span>
        </div>
      </HubTopBand>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-sm text-muted-foreground">选择项目</span>
        <Select value={selectValue} onValueChange={handleSelectChange}>
          <SelectTrigger size="default" className="min-w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_PROJECT_VALUE}>-- 请选择项目 --</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.path} value={project.path}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => void loadTasks()}>
          <RefreshCw /> 刷新
        </Button>
      </div>
      <div className="flex shrink-0 items-center border-b border-border px-4 py-1 text-xs">
        {loadState === 'error' ? (
          <span className="text-destructive">{statusMessage}</span>
        ) : (
          <span className="text-muted-foreground">{statusMessage}</span>
        )}
      </div>
      {selectedProjectPath === '' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
          <Activity className="h-10 w-10 text-muted-foreground" />
          <div className="text-sm text-muted-foreground">先选择一个项目，就能看到它的任务</div>
          <p className="text-xs text-muted-foreground">在上方选择项目，或前往「画布」打开一个项目后回到这里。</p>
          <Button onClick={() => void setCurrentTab('canvas')}>
            <LayoutGrid /> 前往画布
          </Button>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-4 py-2">
            {/* 筛选片选中态按属性驱动（按钮样式标准 §6：不得用形态表达选择态）：
                aria-pressed + 条件令牌类承载选中填充，视觉与原 secondary 填充一致 */}
            {FILTER_OPTIONS.map((option) => {
              const active = activeFilter === option.value;
              return (
                <Button
                  key={option.value || 'all'}
                  size="sm"
                  variant="ghost"
                  aria-pressed={active}
                  className={cn(active && 'bg-secondary text-secondary-foreground hover:bg-secondary/80')}
                  onClick={() => filterTasks(option.value)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {tasks.length > 0 ? (
              <div className="flex flex-col gap-2">
                {tasks.map((task) => (
                  <TaskItem key={task.taskId} task={task} progress={progressCache.get(task.taskId)} />
                ))}
              </div>
            ) : loadState === 'error' ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <AlertCircle className="h-10 w-10 text-muted-foreground" />
                <div className="text-sm text-destructive">没能读取任务列表</div>
                <Button variant="outline" onClick={() => void loadTasks()}>
                  <RefreshCw /> 刷新
                </Button>
              </div>
            ) : loadState === 'loading' ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在读取任务列表...</div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <Inbox className="h-10 w-10 text-muted-foreground" />
                <div className="text-sm text-muted-foreground">还没有任务</div>
                <p className="text-xs text-muted-foreground">这个项目还没有生成任务，生成后会出现在这里。</p>
                <Button variant="outline" onClick={() => void loadTasks()}>
                  <RefreshCw /> 刷新
                </Button>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center border-t border-border px-4 py-1 text-xs">
            <span className="text-muted-foreground">{taskStatusMessage}</span>
          </div>
        </>
      )}
    </div>
  );
}
