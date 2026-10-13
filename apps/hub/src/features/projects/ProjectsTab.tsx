import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Input } from '@iart/ui';
import { Folder, FolderInput, Plus, RefreshCw, Search, Upload } from 'lucide-react';
import { useHubStore } from '../../client/store/hub-store';
import { useProjects, type CreateProjectPayload } from './ProjectsTab.hooks';
import { CreateProjectDialog } from './CreateProjectDialog';
import { ProjectCard } from './ProjectCard';
import { HubTopBand } from '../../components/HubTopBand';

export function ProjectsTab() {
  const {
    projects,
    statusMessage,
    loadProjects,
    openProject,
    createProject,
    deleteProject,
    exportProject,
    importProjectFile,
    importProjectFolder,
    revealProjectFolder,
  } = useProjects();
  const openedProjectPaths = useHubStore((s) => s.projects.openedProjectPaths);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [search, setSearch] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const openCreateProjectDialog = (): void => {
    setCreateDialogOpen(true);
  };

  const handleCreateConfirm = (payload: CreateProjectPayload): void => {
    setCreateDialogOpen(false);
    void createProject(payload.name, payload.dir);
  };

  const handleImportFileClick = (): void => {
    const input = fileInputRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  };

  const handleImportFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const input: HTMLInputElement = event.currentTarget;
    const file: File | undefined = input.files ? Array.from(input.files)[0] : undefined;
    input.value = '';
    if (file) {
      void importProjectFile(file);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects.list;
    return projects.list.filter((p) => (p.name ?? '').toLowerCase().includes(q));
  }, [projects.list, search]);

  const statusText: string = projects.error
    ? projects.error
    : projects.loading
      ? '正在读取项目列表...'
      : statusMessage
        ? statusMessage
        : '共 ' + projects.list.length + ' 个项目';

  return (
    <div className="flex h-full w-full flex-col">
      {/* 顶栏带（spec docs/hub/window-chrome.md §6.1/§6.3）：主操作 primary（带图标），
          次要操作收敛进下拉，右侧搜索；带高/拖拽/平台让位由 HubTopBand 固化 */}
      <HubTopBand className="justify-between">
        <div className="flex gap-2">
          <Button onClick={openCreateProjectDialog}>
            <Plus /> 新项目
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">导入</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={handleImportFileClick}>
                <Upload /> 导入项目文件
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void importProjectFolder()}>
                <FolderInput /> 导入项目文件夹
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" onClick={() => void loadProjects()} title="刷新列表">
            <RefreshCw />
          </Button>
        </div>
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索项目" className="pl-8" />
        </div>
      </HubTopBand>
      <input
        ref={fileInputRef}
        type="file"
        accept=".iarts,.iarts.zip,application/zip"
        className="hidden"
        onChange={handleImportFileChange}
      />
      {/* 状态条 */}
      <div className="flex shrink-0 items-center border-b border-border px-4 py-1 text-xs">
        {projects.error ? (
          <span className="text-destructive">{statusText}</span>
        ) : (
          <span className="text-muted-foreground">{statusText}</span>
        )}
      </div>
      {/* 卡片网格（spec §8.2：资产类内容用卡片网格，信息层级为视觉主体） */}
      <div className="flex-1 overflow-y-auto p-4">
        {projects.list.length === 0 && !projects.loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Folder className="h-10 w-10 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">还没有项目，创建一个开始创作</div>
            <Button onClick={openCreateProjectDialog}>
              <Plus /> 创建项目
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">没有匹配的项目</div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
            {filtered.map((project) => (
              <ProjectCard
                key={project.path}
                project={project}
                isOpened={openedProjectPaths.includes(project.path)}
                onOpen={() => void openProject(project.path)}
                onDelete={() => void deleteProject(project.path, project.name)}
                onExport={() => void exportProject(project.path, project.name)}
                onReveal={() => void revealProjectFolder(project.path)}
              />
            ))}
          </div>
        )}
      </div>
      <CreateProjectDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} onConfirm={handleCreateConfirm} />
    </div>
  );
}
