import { useState } from 'react';
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@iart/ui';
import { FolderOpen, Package, RefreshCw, Search } from 'lucide-react';
import { usePackages } from './PackagesTab.hooks';
import { PackageCard } from './PackageCard';
import { PackagePreviewDialog } from './PackagePreviewDialog';
import { HubTopBand } from '../../components/HubTopBand';

/**
 * 包管理 Tab：每个项目的打包产物（packages/ 下自描述包文件夹）的
 * 高效查找（搜索）、定位（Finder reveal）、预览（package-media 协议）、重命名与删除。
 */
export function PackagesTab() {
  const {
    projects,
    selectedProjectPath,
    setSelectedProjectPath,
    filtered,
    loading,
    error,
    statusMessage,
    search,
    setSearch,
    refresh,
    renamePackage,
    deletePackage,
    revealPackage,
  } = usePackages();
  const [previewing, setPreviewing] = useState<typeof filtered[number] | null>(null);

  const statusText: string = error
    ? error
    : loading
      ? '正在读取包列表...'
      : statusMessage
        ? statusMessage
        : selectedProjectPath
          ? `共 ${filtered.length} 个包`
          : '';

  return (
    <div className="flex h-full w-full flex-col">
      {/* 顶栏带（spec docs/hub/window-chrome.md §6.1/§6.3）：项目选择 + 刷新 + 搜索 */}
      <HubTopBand className="justify-between">
        <div className="flex items-center gap-2">
          <Select
            value={selectedProjectPath}
            onValueChange={(value) => setSelectedProjectPath(value)}
          >
            <SelectTrigger size="default" className="w-64">
              <SelectValue placeholder="选择项目" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.path} value={project.path}>
                  {project.name || '未命名项目'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="icon" onClick={refresh} title="刷新包列表">
            <RefreshCw />
          </Button>
        </div>
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索包名"
            className="pl-8"
          />
        </div>
      </HubTopBand>
      {/* 状态条 */}
      <div className="flex shrink-0 items-center border-b border-border px-4 py-1 text-xs">
        {error !== null && error !== undefined && error !== '' ? (
          <span className="text-destructive">{statusText}</span>
        ) : (
          <span className="text-muted-foreground">{statusText}</span>
        )}
      </div>
      {/* 包卡片网格 */}
      <div className="flex-1 overflow-y-auto p-4">
        {projects.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <FolderOpen className="h-10 w-10 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">还没有项目，先去「画布」创建一个</div>
          </div>
        ) : selectedProjectPath !== '' && filtered.length === 0 && !loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Package className="h-10 w-10 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">这个项目还没有包</div>
            <div className="max-w-md text-xs text-muted-foreground">
              在画布上把素材加入打包区，点「执行打包」，打好包的素材就会出现在这里。
            </div>
          </div>
        ) : filtered.length === 0 && !loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">没有匹配的包</div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
            {filtered.map((pkg) => (
              <PackageCard
                key={pkg.packageId}
                pkg={pkg}
                onPreview={() => setPreviewing(pkg)}
                onRename={(name) => renamePackage(pkg.packageId, name)}
                onDelete={async () => {
                  await deletePackage(pkg.packageId, pkg.name);
                }}
                onReveal={() => void revealPackage(pkg.packageId)}
              />
            ))}
          </div>
        )}
      </div>
      <PackagePreviewDialog pkg={previewing} onOpenChange={(open) => { if (!open) setPreviewing(null); }} />
    </div>
  );
}
