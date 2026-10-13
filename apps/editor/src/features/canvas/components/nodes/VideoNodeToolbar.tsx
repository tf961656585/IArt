'use client';

import { memo } from 'react';
import { NodeToolbar, Position } from '@xyflow/react';
import { IconLayoutGrid, IconPhoto, IconScissors } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { VideoMeta } from '../../types';

interface VideoNodeToolbarProps {
  nodeId: string;
  videoUrl: string | null;
  videoMeta: VideoMeta | null;
  visible: boolean;
  onSpriteSheetClick: () => void;
  onTrimClick: () => void;
  onFrameCaptureClick: () => void;
}

export const VideoNodeToolbar = memo(function VideoNodeToolbar({
  nodeId,
  videoUrl,
  visible,
  onSpriteSheetClick,
  onTrimClick,
  onFrameCaptureClick,
}: VideoNodeToolbarProps) {
  // 媒体工具入口与资产存在性对齐：节点未持有视频内容时不呈现工具栏
  const hasVideo = Boolean(videoUrl);

  if (!hasVideo) {
    return null;
  }

  return (
    <NodeToolbar
      nodeId={nodeId}
      isVisible={visible}
      position={Position.Top}
      /* offset 14 = 选中环外扩 6px + 视觉余量 8px（对齐设计层 node-chrome.js BAR_GAP） */
      offset={14}
    >
      <div className="rounded border bg-card shadow-sm p-1 flex gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              className="rounded-full"
              disabled={false}
              onClick={(e) => {
                e.stopPropagation();
                onTrimClick();
              }}
              aria-label="裁切视频"
              title="裁切视频"
            >
              <IconScissors size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            裁切视频
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              className="rounded-full"
              disabled={false}
              onClick={(e) => {
                e.stopPropagation();
                onFrameCaptureClick();
              }}
              aria-label="截取帧"
              title="截取帧"
            >
              <IconPhoto size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            截取帧
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              className="rounded-full"
              disabled={false}
              onClick={(e) => {
                e.stopPropagation();
                onSpriteSheetClick();
              }}
              aria-label="序列帧图集"
              title="序列帧图集"
            >
              <IconLayoutGrid size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            序列帧图集
          </TooltipContent>
        </Tooltip>
      </div>
    </NodeToolbar>
  );
});

export default VideoNodeToolbar;
