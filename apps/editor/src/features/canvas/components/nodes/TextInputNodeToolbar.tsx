'use client';

import { memo } from 'react';
import { NodeToolbar, Position } from '@xyflow/react';
import { IconMaximize, IconSparkles } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface TextInputNodeToolbarProps {
  nodeId: string;
  disabled: boolean | undefined;
  visible: boolean;
  onAiEditClick: () => void;
  showExpandEdit: boolean | undefined;
  onExpandEditClick: () => void | undefined;
}

export const TextInputNodeToolbar = memo(function TextInputNodeToolbar({
  nodeId,
  disabled,
  visible,
  onAiEditClick,
  showExpandEdit = false,
  onExpandEditClick,
}: TextInputNodeToolbarProps) {
  if (disabled) {
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
        {showExpandEdit ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="secondary"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  // 防止按钮抢焦点导致 editor selection 失效（用于打开弹窗前采样）。
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onExpandEditClick !== null && onExpandEditClick !== undefined) {
                    onExpandEditClick();
                  }
                }}
                aria-label="放大编辑"
                title="放大编辑"
              >
                <IconMaximize size={16} />
                放大编辑
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" align="center">
              放大编辑
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation();
                onAiEditClick();
              }}
              aria-label="AI 修改"
              title="AI 修改"
            >
              <IconSparkles size={16} />
              AI 修改
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align="center">
            AI 修改
          </TooltipContent>
        </Tooltip>
      </div>
    </NodeToolbar>
  );
});

export default TextInputNodeToolbar;
