import { useEffect, useState } from 'react';
import type { PackageSummary } from '@iart/contracts';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@iart/ui';
import { Music, Package } from 'lucide-react';

/**
 * 包预览：网格呈现包内全部素材（顺序标记与包内文件顺序一致）。
 * 图片直出 / 视频控件 / 音频占位卡；单个文件加载失败降级为缺失占位，不留死图。
 */
export interface PackagePreviewDialogProps {
  pkg: PackageSummary | null;
  onOpenChange: (open: boolean) => void;
}

export function PackagePreviewDialog({ pkg, onOpenChange }: PackagePreviewDialogProps) {
  const [brokenUrls, setBrokenUrls] = useState<ReadonlySet<string>>(new Set());

  // 包切换时重置加载失败标记。
  useEffect(() => {
    setBrokenUrls(new Set());
  }, [pkg?.packageId]);

  if (pkg === null) return null;

  const markBroken = (url: string): void => {
    setBrokenUrls((current) => new Set(current).add(url));
  };

  return (
    <Dialog open={pkg !== null} onOpenChange={onOpenChange}>
      <DialogContent form="standard" size="standard">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" /> {pkg.name}
            <span className="text-sm font-normal text-muted-foreground">
              · {pkg.entryCount} 项素材 · {pkg.folderName}/
            </span>
          </DialogTitle>
        </DialogHeader>
        <DialogBody variant="scroll">
        {pkg.entries.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            这个包里还没有素材
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
            {pkg.entries.map((entry, index) => (
              <div key={`${entry.fileName}-${index}`} className="space-y-1">
                <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-muted/40">
                  {brokenUrls.has(entry.url) ? (
                    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                      文件找不到了
                    </div>
                  ) : entry.mediaType === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={entry.url}
                      alt=""
                      draggable={false}
                      onError={() => markBroken(entry.url)}
                      className="h-full w-full object-contain"
                    />
                  ) : entry.mediaType === 'video' ? (
                    <video
                      src={entry.url}
                      controls
                      preload="metadata"
                      onError={() => markBroken(entry.url)}
                      className="h-full w-full object-contain"
                    >
                      <track kind="captions" />
                    </video>
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                      <Music className="h-8 w-8" />
                      <span className="text-xs">音频</span>
                    </div>
                  )}
                  <span className="absolute left-2 top-2 flex h-5 min-w-5 items-center justify-center rounded bg-black/60 px-1 font-mono text-[10px] font-semibold text-white">
                    {index + 1}
                  </span>
                </div>
                <div className="truncate font-mono text-[10px] text-muted-foreground/70" title={entry.fileName}>
                  {entry.fileName}
                </div>
              </div>
            ))}
          </div>
        )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
