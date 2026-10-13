'use client';

/**
 * 画板工具栏组件
 * - 撤销/重做
 * - 网格吸附 / 自动整理 / 删除选中
 * - 提示词收藏
 * - 画布对象查找器(跨类型查找并定位视口,Cmd/Ctrl+G 聚焦)
 */

import type { ReactNode, RefObject } from 'react';
import { useCallback, useState } from 'react';
import {
  IconArrowBack,
  IconArrowForward,
  IconTrash,
  IconLayoutGrid,
  IconArrowsSort,
  IconBookmarks,
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { useCanvasStore } from '../../store/canvasStore';
import type { NodeSize } from '../../types';
import { PromptCollectionDialog } from '../floating';
import { CanvasObjectFinder } from './canvasObjectFinder';
import { AlignmentMenu } from './AlignmentMenu';

export interface CanvasToolbarProps {
  rightSlot: ReactNode | undefined;
  /** measured size ref holder（来自 NodeCanvas 上抛），供全局整理读取真实尺寸防重叠 */
  measuredSizeByNodeIdRef: RefObject<Readonly<Record<string, NodeSize>>>;
  /** 组节点派生尺寸 ref holder（来自 NodeCanvas 上抛），供全局整理读取组节点真实尺寸 */
  derivedSizeByNodeIdRef: RefObject<Readonly<Record<string, NodeSize>>>;
}

export function CanvasToolbar(props: CanvasToolbarProps) {
  const { rightSlot, measuredSizeByNodeIdRef, derivedSizeByNodeIdRef } = props;
  const nodeGraph = useCanvasStore((state) => state.nodeGraph);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const canUndo = useCanvasStore((state) => state.canUndo());
  const canRedo = useCanvasStore((state) => state.canRedo());
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const snapToGridEnabled = useCanvasStore((state) => (state.nodeGraph !== null && state.nodeGraph !== undefined && state.nodeGraph.settings !== null && state.nodeGraph.settings !== undefined ? state.nodeGraph.settings.snapToGrid : undefined) ?? false);
  const toggleSnapToGrid = useCanvasStore((state) => state.toggleSnapToGrid);
  const selectedAnnotationIds = useCanvasStore((state) => state.selectedAnnotationIds);
  const deleteSelectedElements = useCanvasStore((state) => state.deleteSelectedElements);
  const autoLayoutWithPreMeasure = useCanvasStore((state) => state.autoLayoutWithPreMeasure);
  const [promptCollectionOpen, setPromptCollectionOpen] = useState(false);
  const [autoLayoutInProgress, setAutoLayoutInProgress] = useState(false);

  // 删除选中元素（节点、边、注释）
  const handleDeleteSelected = useCallback(() => {
    deleteSelectedElements();
  }, [deleteSelectedElements]);

  // 自动整理节点
  // 全局整理走预挂载测量（spec：画布自动布局算法.md「全局整理的预挂载测量」）：
  // 先临时关闭节点虚拟化让视口外节点产出 measured，再调算法，保证 sizeMap 接近真实渲染尺寸。
  // 组节点尺寸只能由 derived 承载（不回退 measured/desired），必须把组节点派生尺寸传入。
  const handleAutoLayout = useCallback(async () => {
    if (autoLayoutInProgress) return;
    setAutoLayoutInProgress(true);
    try {
      const result = await autoLayoutWithPreMeasure({
        measuredSizeByNodeId: measuredSizeByNodeIdRef.current,
        derivedSizeByNodeId: derivedSizeByNodeIdRef.current,
      });
      if (!result) return;

      if (result.changedCount === 0) {
        toast.info('节点位置已经整齐，不用整理');
        return;
      }

      toast.success('整理完成', {
        description: `调整了 ${result.changedCount} 个节点的位置`,
      });
    } finally {
      setAutoLayoutInProgress(false);
    }
  }, [autoLayoutWithPreMeasure, measuredSizeByNodeIdRef, derivedSizeByNodeIdRef, autoLayoutInProgress]);

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b bg-card">
      {/* 撤销/重做 */}
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={undo}
          disabled={!canUndo}
          title="撤销"
        >
          <IconArrowBack size={16} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={redo}
          disabled={!canRedo}
          title="重做"
        >
          <IconArrowForward size={16} />
        </Button>
      </div>

      <Separator orientation="vertical" className="h-6" />

      {/* 吸附 & 删除 */}
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant={snapToGridEnabled ? 'secondary' : 'ghost'}
          onClick={() => toggleSnapToGrid(undefined)}
          title={snapToGridEnabled ? '关闭网格吸附' : '开启网格吸附'}
        >
          <IconLayoutGrid size={16} className="mr-1" />
          吸附
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleAutoLayout}
          disabled={!nodeGraph || ((nodeGraph !== null && nodeGraph !== undefined && nodeGraph.nodes !== null && nodeGraph.nodes !== undefined ? nodeGraph.nodes.length : undefined) ?? 0) === 0}
          title="自动整理节点"
        >
          <IconArrowsSort size={16} className="mr-1" />
          整理
        </Button>
        <AlignmentMenu />
        <Button
          size="sm"
          variant="ghost"
          onClick={handleDeleteSelected}
          disabled={selectedNodeIds.length === 0 && selectedAnnotationIds.length === 0}
          title="删除选中"
        >
          <IconTrash size={16} />
        </Button>
      </div>

      <Separator orientation="vertical" className="h-6" />

      {/* 提示词收藏 */}
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPromptCollectionOpen(true)}
          title="提示词收藏"
        >
          <IconBookmarks size={16} className="mr-1" />
          收藏
        </Button>
      </div>

      <Separator orientation="vertical" className="h-6" />

      {/* 画布对象查找器(定位视口) */}
      <CanvasObjectFinder />

      <div className="flex-1" />

      {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}

      <PromptCollectionDialog
        open={promptCollectionOpen}
        onOpenChange={setPromptCollectionOpen}
        onApply={undefined}
      />
    </div>
  );
}

export default CanvasToolbar;
