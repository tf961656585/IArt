import type { ProjectIndexItem } from '@iart/contracts';
import { Badge, Card, CardContent, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@iart/ui';
import { Download, ExternalLink, Folder, FolderOpen, Trash2 } from 'lucide-react';
import { formatTime } from '../../client/utils/time';

export interface ProjectCardProps {
  project: ProjectIndexItem;
  isOpened: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onExport: () => void;
  onReveal: () => void;
}

/**
 * 项目卡（信息层级卡，spec: docs/hub/visual-design.md §8.2/§9.1）。
 * 视觉主体：类型图标 + 名称（展示标题级）+ 等宽元信息行。
 * 主操作（打开）经卡片点击触发；次要操作（导出/定位/删除）经右键 ContextMenu。
 */
export function ProjectCard({ project, isOpened, onOpen, onDelete, onExport, onReveal }: ProjectCardProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Card
          role="button"
          tabIndex={0}
          className="gap-0 cursor-pointer p-0 transition hover:bg-elevated hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onOpen}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpen();
            }
          }}
        >
          <CardContent className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              {isOpened ? (
                <FolderOpen className="h-5 w-5 text-primary" />
              ) : (
                <Folder className="h-5 w-5 text-muted-foreground" />
              )}
              <Badge variant={isOpened ? 'default' : 'secondary'}>{isOpened ? '已打开' : '可打开'}</Badge>
            </div>
            <div className="truncate text-base font-medium">{project.name || '未命名项目'}</div>
            <div className="font-mono text-xs text-muted-foreground">上次保存 {formatTime(project.savedAt)}</div>
          </CardContent>
        </Card>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onExport}>
          <Download /> 导出
        </ContextMenuItem>
        <ContextMenuItem onClick={onReveal}>
          <ExternalLink /> 打开所在文件夹
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 /> 删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
