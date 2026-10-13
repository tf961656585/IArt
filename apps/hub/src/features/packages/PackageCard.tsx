import { useState } from 'react';
import type { PackageSummary } from '@iart/contracts';
import {
  Badge,
  Button,
  Card,
  CardContent,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@iart/ui';
import { ExternalLink, Music, Package, Pencil, Play, Trash2 } from 'lucide-react';
import { formatTime } from '../../client/utils/time';

/** 包内媒体预览：图片直出 / 视频首帧 / 音频图标占位（url 由 Main 的 package-media 协议提供）。 */
export function PackageMediaThumb({
  mediaType,
  url,
  className,
}: {
  mediaType: string;
  url: string;
  className?: string;
}) {
  if (!url) {
    return (
      <div className={`flex h-full w-full items-center justify-center bg-muted text-muted-foreground ${className ?? ''}`}>
        <Package className="h-6 w-6" />
      </div>
    );
  }
  if (mediaType === 'image') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" draggable={false} className={`h-full w-full object-cover ${className ?? ''}`} />
    );
  }
  if (mediaType === 'video') {
    return (
      <video
        src={url}
        preload="metadata"
        muted
        playsInline
        className={`h-full w-full object-cover ${className ?? ''}`}
      />
    );
  }
  return (
    <div className={`flex h-full w-full items-center justify-center bg-muted text-muted-foreground ${className ?? ''}`}>
      <Music className="h-6 w-6" />
    </div>
  );
}

function pickCover(pkg: PackageSummary): { mediaType: string; url: string } | null {
  for (const entry of pkg.entries) {
    if (entry.mediaType === 'image' || entry.mediaType === 'video') {
      return { mediaType: entry.mediaType, url: entry.url };
    }
  }
  return null;
}

export interface PackageCardProps {
  pkg: PackageSummary;
  onPreview: () => void;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => Promise<void>;
  onReveal: () => void;
}

/**
 * 包卡片（信息层级卡，对齐 ProjectCard 视觉语言）。
 * 主操作（预览）经卡片点击触发；次要操作（重命名/Finder 定位/删除）经右键 ContextMenu；
 * 重命名与删除（破坏性操作，需显式确认）走 Dialog。
 */
export function PackageCard({ pkg, onPreview, onRename, onDelete, onReveal }: PackageCardProps) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState(pkg.name);
  const [deleting, setDeleting] = useState(false);

  const cover = pickCover(pkg);
  const openRename = () => {
    setName(pkg.name);
    setRenameOpen(true);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Card
            role="button"
            tabIndex={0}
            className="group gap-0 cursor-pointer overflow-hidden p-0 transition hover:bg-elevated hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onPreview}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onPreview();
              }
            }}
          >
            {/* 封面：首个图片/视频条目（预览即包内容） */}
            <div className="relative aspect-video w-full overflow-hidden bg-muted">
              {cover !== null ? (
                <PackageMediaThumb mediaType={cover.mediaType} url={cover.url} />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                  <Package className="h-8 w-8" />
                </div>
              )}
              <Badge variant="secondary" className="absolute left-2 top-2">
                {pkg.entryCount} 项素材
              </Badge>
              <Button
                variant="secondary"
                size="sm"
                className="absolute bottom-2 right-2 h-7 opacity-0 transition group-hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation();
                  onPreview();
                }}
              >
                <Play /> 预览
              </Button>
            </div>
            <CardContent className="flex flex-col gap-1.5 p-3">
              <div className="truncate text-sm font-medium">{pkg.name}</div>
              <div className="font-mono text-xs text-muted-foreground">打包于 {formatTime(pkg.createdAt)}</div>
              <div className="truncate font-mono text-2xs text-muted-foreground/70" title={pkg.path}>
                {pkg.folderName}/
              </div>
            </CardContent>
          </Card>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onPreview}>
            <Play /> 预览
          </ContextMenuItem>
          <ContextMenuItem onClick={openRename}>
            <Pencil /> 重命名
          </ContextMenuItem>
          <ContextMenuItem onClick={onReveal}>
            <ExternalLink /> 打开所在文件夹
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 /> 删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* 重命名 */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent form="standard" size="compact">
          <DialogHeader>
            <DialogTitle>重命名包</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="package-rename-input">包名</Label>
            <Input
              id="package-rename-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void onRename(name.trim()).then((ok) => {
                    if (ok) setRenameOpen(false);
                  });
                }
              }}
            />
            <p className="text-xs text-muted-foreground">文件夹名会一起改成新名字。</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                void onRename(name.trim()).then((ok) => {
                  if (ok) setRenameOpen(false);
                });
              }}
            >
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认（破坏性操作显式确认） */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent form="standard" size="compact">
          <DialogHeader>
            <DialogTitle>删除包「{pkg.name}」？</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            包会被移到系统回收站（可以恢复），项目里的素材不受影响。
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                setDeleting(true);
                void onDelete().finally(() => {
                  setDeleting(false);
                  setDeleteOpen(false);
                });
              }}
            >
              <Trash2 /> {deleting ? '正在删除...' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
