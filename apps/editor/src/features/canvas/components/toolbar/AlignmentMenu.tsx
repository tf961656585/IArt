'use client';

/**
 * 对齐/分布选中节点下拉菜单。
 *
 * 提供 8 种对齐/分布操作（参照 yEd / draw.io / Figma 标准）：
 * - 水平对齐：左 / 水平居中 / 右
 * - 垂直对齐：顶 / 垂直居中 / 底
 * - 分布：水平等距 / 垂直等距
 *
 * 触发条件：对齐需 ≥2 节点，分布需 ≥3 节点。
 */

import {
  IconAlignLeft,
  IconAlignCenter,
  IconAlignRight,
  IconAlignJustified,
  IconArrowsHorizontal,
  IconArrowsVertical,
  type TablerIcon,
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu';
import { useCanvasStore } from '../../store/canvasStore';
import type { AlignmentMode } from '../../layout/alignment';

interface AlignmentOption {
  mode: AlignmentMode;
  label: string;
  shortcut: string;
  icon: TablerIcon;
  needsDistribute: boolean;
}

const ALIGNMENT_OPTIONS: AlignmentOption[] = [
  { mode: 'left', label: '左对齐', shortcut: 'Alt+L', icon: IconAlignLeft, needsDistribute: false },
  { mode: 'centerHorizontal', label: '水平居中', shortcut: 'Alt+C', icon: IconAlignCenter, needsDistribute: false },
  { mode: 'right', label: '右对齐', shortcut: 'Alt+R', icon: IconAlignRight, needsDistribute: false },
  { mode: 'top', label: '顶对齐', shortcut: 'Alt+T', icon: IconAlignJustified, needsDistribute: false },
  { mode: 'centerVertical', label: '垂直居中', shortcut: 'Alt+M', icon: IconAlignJustified, needsDistribute: false },
  { mode: 'bottom', label: '底对齐', shortcut: 'Alt+B', icon: IconAlignJustified, needsDistribute: false },
  { mode: 'distributeHorizontal', label: '水平分布', shortcut: 'Alt+H', icon: IconArrowsHorizontal, needsDistribute: true },
  { mode: 'distributeVertical', label: '垂直分布', shortcut: 'Alt+V', icon: IconArrowsVertical, needsDistribute: true },
];

export function AlignmentMenu() {
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const alignSelection = useCanvasStore((state) => state.alignSelection);

  const selectedCount = selectedNodeIds.length;
  const canAlign = selectedCount >= 2;
  const canDistribute = selectedCount >= 3;

  const handleSelect = (option: AlignmentOption) => {
    alignSelection(option.mode);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canAlign}
          title="对齐选中节点"
        >
          <IconAlignLeft size={16} className="mr-1" />
          对齐
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel>水平对齐</DropdownMenuLabel>
        {ALIGNMENT_OPTIONS.slice(0, 3).map((option) => (
          <AlignmentMenuItem
            key={option.mode}
            option={option}
            disabled={!canAlign}
            onSelect={handleSelect}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>垂直对齐</DropdownMenuLabel>
        {ALIGNMENT_OPTIONS.slice(3, 6).map((option) => (
          <AlignmentMenuItem
            key={option.mode}
            option={option}
            disabled={!canAlign}
            onSelect={handleSelect}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>分布</DropdownMenuLabel>
        {ALIGNMENT_OPTIONS.slice(6, 8).map((option) => (
          <AlignmentMenuItem
            key={option.mode}
            option={option}
            disabled={!canDistribute}
            onSelect={handleSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface AlignmentMenuItemProps {
  option: AlignmentOption;
  disabled: boolean;
  onSelect: (option: AlignmentOption) => void;
}

function AlignmentMenuItem({ option, disabled, onSelect }: AlignmentMenuItemProps) {
  const Icon = option.icon;
  return (
    <DropdownMenuItem
      disabled={disabled}
      onClick={() => onSelect(option)}
    >
      <Icon size={14} />
      <span className="ml-2 flex-1">{option.label}</span>
      <DropdownMenuShortcut>{option.shortcut}</DropdownMenuShortcut>
    </DropdownMenuItem>
  );
}

export default AlignmentMenu;
