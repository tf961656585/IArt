'use client';
/**
 * 单个角色 Avatar 组件
 * - 圆形图片显示
 * - hover 时放大到 2 倍
 * - 空位显示占位图
 */

import { useState, useCallback, memo, type KeyboardEvent } from 'react';
import { IconUser, IconX } from '@tabler/icons-react';
import NextImage from 'next/image';
import { cn } from '@/lib/utils';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';

interface CharacterAvatarProps {
  /** 角色 ID（为空时显示占位图） */
  characterId: string | null | undefined;
  /** 角色名称（用于 tooltip） */
  characterName: string | undefined;
  /** 角色描述 */
  characterDescription: string | undefined;
  /** 角色图片 URL（本地 /files/...） */
  characterImageUrl: string | null | undefined;
  /** 是否显示删除按钮 */
  showRemove: boolean | undefined;
  /** 点击删除回调 */
  onRemove: () => void | undefined;
  /** 点击回调 */
  onClick: () => void | undefined;
  /** 是否禁用 hover 放大效果 */
  disableHoverZoom: boolean | undefined;
  /** 自定义类名 */
  className: string | undefined;
}

function CharacterAvatarInner({
  characterId,
  characterName,
  characterDescription,
  characterImageUrl,
  showRemove = false,
  onRemove,
  onClick,
  disableHoverZoom = false,
  className,
}: CharacterAvatarProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [imageError, setImageError] = useState(false);

  const imageUrl =
    !imageError && characterImageUrl && characterImageUrl.trim()
      ? characterImageUrl.trim()
      : null;

  const handleMouseEnter = useCallback(() => {
    if (!disableHoverZoom) {
      setIsHovered(true);
    }
  }, [disableHoverZoom]);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
  }, []);

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onRemove !== null && onRemove !== undefined) {
        onRemove();
      }
    },
    [onRemove]
  );

  const handleActivateKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (onClick !== null && onClick !== undefined) {
        onClick();
      }
    },
    [onClick],
  );

  // 空位占位图
  if (!characterId) {
    return (
      <div
        role="button"
        tabIndex={0}
        className={cn(
          'w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center',
          'border-2 border-dashed border-muted-foreground/30',
          'cursor-pointer hover:border-muted-foreground/50 transition-colors',
          className
        )}
        onClick={onClick}
        onKeyDown={handleActivateKey}
      >
        <IconUser className="w-5 h-5 text-muted-foreground/50" />
      </div>
    );
  }

  // 使用固定尺寸的外层容器捕获 hover 事件，防止内层放大时触发 mouseLeave 导致抖动
  const avatarContent = (
      <div
        className={cn('relative w-12 h-12', className)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className={cn(
          'absolute bottom-0 left-1/2 -translate-x-1/2',
          'rounded-full overflow-hidden cursor-pointer',
          'transition-all duration-200 ease-out origin-bottom',
          'w-12 h-12',
          isHovered && !disableHoverZoom && 'w-24 h-24 z-surface-inner shadow-lg'
        )}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={handleActivateKey}
      >
        {imageUrl ? (
          <NextImage
            src={imageUrl}
            alt={characterName || '角色'}
            className="w-full h-full object-cover"
            draggable={false}
            height={96}
            unoptimized
            width={96}
            onError={() => setImageError(true)}
          />
        ) : (
          <div className="w-full h-full bg-muted flex items-center justify-center">
            <IconUser className="w-6 h-6 text-muted-foreground" />
          </div>
        )}

        {/* 删除按钮 */}
        {showRemove && isHovered && (
          <button
            className={cn(
              'absolute -top-1 -right-1 w-5 h-5 rounded-full',
              'bg-destructive text-destructive-foreground',
              'flex items-center justify-center',
              'hover:bg-destructive/90 transition-colors',
              'shadow-sm'
            )}
            onClick={handleRemove}
          >
            <IconX className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );

  // 如果有描述，使用 HoverCard 显示
  if (characterDescription) {
    return (
      <HoverCard openDelay={300} closeDelay={100}>
        <HoverCardTrigger asChild>{avatarContent}</HoverCardTrigger>
        <HoverCardContent side="top" className="w-64">
          <div className="space-y-1">
            <p className="font-medium text-sm">{characterName}</p>
            <p className="text-xs text-muted-foreground line-clamp-3">
              {characterDescription}
            </p>
          </div>
        </HoverCardContent>
      </HoverCard>
    );
  }

  return avatarContent;
}

export const CharacterAvatar = memo(CharacterAvatarInner);
