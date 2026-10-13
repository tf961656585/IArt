'use client';
/**
 * 角色卡片组件
 * - 用于角色库弹窗中展示单个角色
 */

import { useState, useCallback, memo, type KeyboardEvent } from 'react';
import { IconUser, IconPencil, IconTrash } from '@tabler/icons-react';
import NextImage from 'next/image';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import type { CharacterIndexItem } from '../../types/character';

interface CharacterCardProps {
  /** 角色索引数据 */
  character: CharacterIndexItem;
  /** 是否选中 */
  selected: boolean;
  /** 选中状态变更 */
  onSelectedChange: (selected: boolean) => void;
  /** 编辑角色 */
  onEdit: (character: CharacterIndexItem) => void | undefined;
  /** 删除角色 */
  onDelete: (characterId: string) => void | undefined;
}

function CharacterCardInner({
  character,
  selected,
  onSelectedChange,
  onEdit,
  onDelete,
}: CharacterCardProps) {
  const [imageError, setImageError] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const imageUrl =
    !imageError && character.imageUrl && character.imageUrl.trim()
      ? character.imageUrl.trim()
      : null;

  const handleCheckboxChange = useCallback(
    (checked: boolean | 'indeterminate') => {
      onSelectedChange(checked === true);
    },
    [onSelectedChange]
  );

  const handleEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onEdit(character);
    },
    [character, onEdit]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete(character.id);
    },
    [character.id, onDelete]
  );

  const handleCardKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSelectedChange(!selected);
    },
    [onSelectedChange, selected],
  );

  const cardContent = (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'relative group rounded-lg overflow-hidden',
        'transition-all duration-200',
        'hover:shadow-md',
        selected && 'ring-2 ring-primary'
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => onSelectedChange(!selected)}
      onKeyDown={handleCardKeyDown}
    >
      {/* 图片区域：卡片是角色图的唯一完整浏览面，必须完整可见（object-contain），cover 裁切导致观察不可达 */}
      <div className="aspect-square bg-muted">
        {imageUrl ? (
          <NextImage
            src={imageUrl}
            alt={character.name}
            className="w-full h-full object-contain"
            draggable={false}
            height={256}
            unoptimized
            width={256}
            onError={() => setImageError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <IconUser className="w-12 h-12 text-muted-foreground/50" />
          </div>
        )}
      </div>

      {/* 角色名 */}
      <div className="p-2 text-center">
        <p className="text-sm font-medium truncate">{character.name}</p>
      </div>

      {/* 选中框 */}
      <div className="absolute top-2 left-2">
        <Checkbox
          checked={selected}
          onCheckedChange={handleCheckboxChange}
          onClick={(event) => event.stopPropagation()}
          className="bg-background/80"
        />
      </div>

      {/* 操作按钮（hover 时显示） */}
      {isHovered && (
        <div className="absolute top-2 right-2 flex gap-1">
          <Button
            size="icon"
            variant="secondary"
            className="w-6 h-6"
            onClick={handleEdit}
            title="编辑"
          >
            <IconPencil className="w-3 h-3" />
          </Button>
          <Button
            size="icon"
            variant="destructive"
            className="w-6 h-6"
            onClick={handleDelete}
            title="删除"
          >
            <IconTrash className="w-3 h-3" />
          </Button>
        </div>
      )}
    </div>
  );

  // 如果有描述，显示 HoverCard
  if (character.description) {
    return (
      <HoverCard openDelay={500} closeDelay={100}>
        <HoverCardTrigger asChild>{cardContent}</HoverCardTrigger>
        <HoverCardContent side="top" className="w-64">
          <div className="space-y-1">
            <p className="font-medium text-sm">{character.name}</p>
            <p className="text-xs text-muted-foreground line-clamp-4">
              {character.description}
            </p>
          </div>
        </HoverCardContent>
      </HoverCard>
    );
  }

  return cardContent;
}

export const CharacterCard = memo(CharacterCardInner);
