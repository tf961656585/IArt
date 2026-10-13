'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  IconPackage,
  IconMusic,
  IconPhotoOff,
  IconVideo,
  IconFolder,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import type { PackageAreaEntryView, PackageSummary } from '@iart/contracts';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatBeijingTime } from '@/shared/utils/time';
import { usePackageAreaStore } from '../store/packageAreaStore';
import { createPackage, listPackages, revealPackage } from '../storage/backendPackages';
import { useCanvasStore } from '@/features/canvas/store/canvasStore';
import { getCurrentProjectPath } from '@/features/canvas/storage/backendCore';

/**
 * 打包区面板 — 右侧工作区的正式内容之一。
 *
 * spec「右侧工作区与打包区服务」：
 * - 消费 packageAreaStore 的 canonical 排序 PackageAreaView
 * - grid 排列 + 顺序标记（左上角序号 = 打包顺序）
 * - hover 大于 3s 展示素材细节（Tooltip delayDuration=3000）
 * - 条目右键菜单「从打包区移除」（唯一移除入口）
 * - 拖拽排序（reorder-entries mutation）
 * - 「执行打包」：项目路径内新建包文件夹（命名浮层确认后提交）
 * - 头部「打开所在文件夹」常驻定位入口（spec docs/editor/本地文件快捷跳转.md
 *   LFJ-001/002/003/010）：定位最近一次打包产物目录，无已生成包时禁用
 */

const MEDIA_TYPE_LABEL: Record<PackageAreaEntryView['mediaType'], string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
};

/** 默认包名：北京时间 MM-DD HH:mm（时间戳规范：面向用户展示统一北京时间）。 */
const buildDefaultPackageName = (): string => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `打包 ${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
};

const formatDuration = (durationMs: number | null | undefined): string => {
  if (durationMs === null || durationMs === undefined || durationMs <= 0) return '-';
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

/** 单条目媒体预览：图片直出 / 视频首帧 / 音频图标占位 / 失效占位。 */
function EntryMedia({ entry }: { entry: PackageAreaEntryView }) {
  const asset = entry.asset;
  if (asset.isMissing || asset.mediaAsset === null) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 rounded border border-dashed border-border text-muted-foreground">
        <IconPhotoOff size={20} />
        <span className="text-[10px]">素材已失效</span>
      </div>
    );
  }
  const url = asset.mediaAsset.original?.url ?? '';
  if (!url) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded bg-muted text-muted-foreground">
        <IconPhotoOff size={20} />
      </div>
    );
  }
  if (entry.mediaType === 'image') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        draggable={false}
        className="h-full w-full rounded object-cover"
      />
    );
  }
  if (entry.mediaType === 'video') {
    return (
      <div className="relative h-full w-full">
        <video
          src={url}
          preload="metadata"
          muted
          playsInline
          className="h-full w-full rounded object-cover"
        />
        <IconVideo
          size={14}
          className="absolute right-1 top-1 rounded bg-black/50 p-0.5 text-white"
        />
      </div>
    );
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 rounded bg-muted text-muted-foreground">
      <IconMusic size={22} />
      <span className="max-w-full truncate px-1 text-[10px]">音频</span>
    </div>
  );
}

function SortableEntryCard({
  entry,
  index,
  onRemove,
}: {
  entry: PackageAreaEntryView;
  index: number;
  onRemove: (entryId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.packageEntryId,
  });

  const detail = entry.asset.mediaAsset;
  const width = detail?.original?.width;
  const height = detail?.original?.height;

  return (
    <ContextMenu>
      <Tooltip delayDuration={3000}>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              ref={setNodeRef}
              style={{ transform: CSS.Transform.toString(transform), transition }}
              className={`relative block aspect-square w-full overflow-hidden rounded border bg-muted text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isDragging ? 'z-10 opacity-80 shadow-lg' : ''
              }`}
              aria-label={`打包区第 ${index + 1} 项，${MEDIA_TYPE_LABEL[entry.mediaType]}`}
              {...attributes}
              {...listeners}
            >
              <EntryMedia entry={entry} />
              {/* 顺序标记：左上角序号 = 打包顺序 */}
              <span className="absolute left-1 top-1 flex h-5 min-w-5 items-center justify-center rounded bg-black/60 px-1 font-mono text-[10px] font-semibold text-white">
                {index + 1}
              </span>
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        {/* hover 大于 3s 展示素材细节 */}
        <TooltipContent side="left" align="start" className="max-w-64 space-y-1 text-xs">
          <div className="font-medium">{MEDIA_TYPE_LABEL[entry.mediaType]}素材</div>
          {width !== null && width !== undefined && height !== null && height !== undefined ? (
            <div>
              尺寸：{width}×{height}
            </div>
          ) : null}
          {entry.mediaType !== 'image' ? (
            <div>时长：{formatDuration(detail?.original?.durationMs)}</div>
          ) : null}
          <div>加入时间：{formatBeijingTime(entry.createdAt)}</div>
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem
          variant="destructive"
          onSelect={() => onRemove(entry.packageEntryId)}
        >
          从打包区移除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function PackageAreaPanel() {
  const packageArea = usePackageAreaStore((s) => s.packageArea);
  const loading = usePackageAreaStore((s) => s.loading);
  const submitMutation = usePackageAreaStore((s) => s.submitMutation);

  const [packageName, setPackageName] = useState<string | null>(null);
  const [packaging, setPackaging] = useState(false);
  /** 「打开所在文件夹」的定位目标：最近一次打包产物（spec LFJ-001）。projectPath 随目标一起
   * 固化，保证定位结果与目标包同项目（spec「项目锚定」，项目切换不定位到旧项目的包）。 */
  const [revealTarget, setRevealTarget] = useState<{
    projectPath: string;
    packageId: string;
  } | null>(null);

  const entries = useMemo(
    () => (packageArea !== null && packageArea !== undefined ? packageArea.entries : []),
    [packageArea],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const nodeGraph = useCanvasStore((s) => s.nodeGraph);
  const graphId = nodeGraph !== null && nodeGraph !== undefined ? nodeGraph.id : null;

  // 定位目标装载（spec LFJ-001/002）：面板挂载或项目/画布就绪、切换时经 packages:list
  // 取创建时间最新的包作为「最近一次打包产物」。无已生成包 → 目标为空 → 入口禁用。
  // 加载失败不提示（非用户主动动作），debug 留痕（条件跳过必须留痕）。
  useEffect(() => {
    if (graphId === null) {
      setRevealTarget(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const projectPath = await getCurrentProjectPath();
        if (projectPath === null || cancelled) {
          console.debug('[PackageAreaPanel] reveal target: no project path, skip');
          return;
        }
        const { packages } = await listPackages(projectPath);
        if (cancelled) return;
        const latest = packages.reduce<PackageSummary | null>(
          (acc, pkg) => (acc === null || pkg.createdAt > acc.createdAt ? pkg : acc),
          null,
        );
        setRevealTarget(latest === null ? null : { projectPath, packageId: latest.packageId });
      } catch (err) {
        console.debug('[PackageAreaPanel] reveal target load failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [graphId]);

  const ensureGraphId = useCallback((): string | null => {
    const graph = useCanvasStore.getState().nodeGraph;
    return graph ? graph.id : null;
  }, []);

  const handleRemove = useCallback(
    (entryId: string) => {
      const graphId = ensureGraphId();
      if (graphId === null) return;
      void submitMutation(graphId, {
        action: 'remove-entries',
        packageEntryIds: [entryId],
      });
    },
    [submitMutation, ensureGraphId],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (over === null || active.id === over.id) return;
      const oldIndex = entries.findIndex((e) => e.packageEntryId === active.id);
      const newIndex = entries.findIndex((e) => e.packageEntryId === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const graphId = ensureGraphId();
      if (graphId === null) {
        toast.error('画布还没准备好，暂时不能排序，请稍后再试');
        return;
      }
      const reordered = arrayMove(entries, oldIndex, newIndex);
      void submitMutation(graphId, {
        action: 'reorder-entries',
        orderedEntryIds: reordered.map((e) => e.packageEntryId),
      });
    },
    [entries, submitMutation, ensureGraphId],
  );

  // 定位最近一次打包产物目录（spec LFJ-003/010/011）：走 packages:reveal 通道由主进程
  // 定位；失败（ok:false 或异常）给可见反馈，不静默、不自动打开其他位置替代。
  const handleRevealLatestPackage = useCallback(async () => {
    if (revealTarget === null) return;
    try {
      const result = await revealPackage(revealTarget.projectPath, revealTarget.packageId);
      if (!result.ok) {
        toast.error('没能找到打包文件夹，可能已被移动或删除');
      }
    } catch (err) {
      console.error('[PackageAreaPanel] reveal package failed', err);
      toast.error('没能找到打包文件夹，可能已被移动或删除');
    }
  }, [revealTarget]);

  const openNaming = useCallback(() => {
    setPackageName(buildDefaultPackageName());
  }, []);

  const handleConfirmPackage = useCallback(async () => {
    const name = (packageName ?? '').trim();
    if (!name) {
      toast.error('请输入包名');
      return;
    }
    const graphId = ensureGraphId();
    if (graphId === null) {
      toast.error('画布还没准备好，暂时不能打包，请稍后再试');
      return;
    }
    const projectPath = await getCurrentProjectPath();
    if (!projectPath) {
      toast.error('项目还没准备好，暂时不能打包，请稍后再试');
      return;
    }
    setPackaging(true);
    try {
      const result = await createPackage(projectPath, name, entries.map((e) => e.assetId));
      if (result.package === null) {
        toast.error('打包失败：打包区里的素材都已失效，请重新加入后再打包');
        return;
      }
      setPackageName(null);
      // 打包成功后定位入口立即可用并指向新包（spec LFJ-002）。
      setRevealTarget({ projectPath, packageId: result.package.packageId });
      if (result.skippedAssetIds.length > 0) {
        toast.success(
          `已创建包「${result.package.name}」，含 ${result.package.entryCount} 项素材；${result.skippedAssetIds.length} 项失效素材已跳过`,
        );
      } else {
        toast.success(`已创建包「${result.package.name}」，共 ${result.package.entryCount} 项素材`);
      }
    } catch (err) {
      console.error('[PackageAreaPanel] create package failed', err);
      toast.error('打包失败');
    } finally {
      setPackaging(false);
    }
  }, [packageName, entries, ensureGraphId]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        正在加载打包区…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="package-area-panel">
      {/* 头部：计数 + 打开所在文件夹 + 执行打包 */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs text-muted-foreground">{entries.length} 项素材</span>
        <div className="flex items-center gap-1">
          {/* 「打开所在文件夹」常驻定位入口（spec docs/editor/本地文件快捷跳转.md
              LFJ-001/002/010）：与「执行打包」同一栏，定位最近一次打包产物目录。 */}
          <Button
            type="button"
            variant="ghost"
            size="2xs"
            disabled={revealTarget === null}
            onClick={() => void handleRevealLatestPackage()}
            className="text-muted-foreground"
            aria-label="打开所在文件夹"
          >
            <IconFolder size={14} className="size-3.5" />
            打开所在文件夹
          </Button>
          <Popover
            open={packageName !== null}
            onOpenChange={(open) => {
              if (open) openNaming();
              else setPackageName(null);
            }}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="2xs"
                disabled={entries.length === 0}
                className="text-muted-foreground"
                aria-label="执行打包"
              >
                <IconPackage size={14} className="size-3.5" />
                执行打包
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 space-y-2">
              <p className="text-xs text-muted-foreground">
                打包会新建一个包文件夹，并把打包区里的素材复制进去。
              </p>
              <Input
                value={packageName ?? ''}
                onChange={(event) => setPackageName(event.target.value)}
                placeholder="包名"
                aria-label="包名"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleConfirmPackage();
                }}
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setPackageName(null)}>
                  取消
                </Button>
                <Button size="sm" loading={packaging} onClick={() => void handleConfirmPackage()}>
                  创建包
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* 打包条目 grid（拖拽排序） */}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
            <IconPackage size={24} className="opacity-60" />
            <p>还没有要打包的素材</p>
            <p className="text-xs">
              在画布上选中要交付的图片 / 视频 / 音频，点「加入打包区」把它们收集到这里。
            </p>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
              items={entries.map((e) => e.packageEntryId)}
              strategy={rectSortingStrategy}
            >
              <div className="grid grid-cols-3 gap-2">
                {entries.map((entry, index) => (
                  <SortableEntryCard
                    key={entry.packageEntryId}
                    entry={entry}
                    index={index}
                    onRemove={handleRemove}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}
