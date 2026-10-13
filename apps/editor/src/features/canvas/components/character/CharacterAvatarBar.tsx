'use client';
/**
 * 角色 Avatar 行组件
 * - 最多显示 10 个 avatar
 * - 空位显示占位图
 * - 最右侧"更多"按钮打开角色库
 */

import { useMemo, useCallback, useEffect, useRef } from 'react';
import { IconDots } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CharacterAvatar } from './CharacterAvatar';
import { useCanvasStore } from '../../store/canvasStore';
import { useCharacterUIStore } from '../../store/characterUIStore';
import { MAX_AVATAR_DISPLAY_COUNT } from '../../types/character';

export function CharacterAvatarBar() {
  const nodeGraphId = useCanvasStore((s) => (s.nodeGraph !== null && s.nodeGraph !== undefined ? s.nodeGraph.id : undefined) ?? null);
  const setSelectedCharacters = useCanvasStore((s) => s.setSelectedCharacters);

  const openLibrary = useCharacterUIStore((s) => s.openLibrary);
  const startPlacement = useCharacterUIStore((s) => s.startPlacement);

  const characterIndexItems = useCharacterUIStore((s) => s.characters);
  const hasLoaded = useCharacterUIStore((s) => s.hasLoaded);
  const isLoading = useCharacterUIStore((s) => s.isLoading);
  const lastCharacterIndexLoadOk = useCharacterUIStore((s) => s.lastCharacterIndexLoadOk);
  const pinnedCharacterIds = useCharacterUIStore((s) => s.pinnedCharacterIds);
  const pinsLoading = useCharacterUIStore((s) => s.pinsLoading);
  const lastPinsLoadOk = useCharacterUIStore((s) => s.lastPinsLoadOk);
  const migrationPending = useCharacterUIStore((s) => s.migrationPending);
  const loadCharacters = useCharacterUIStore((s) => s.loadCharacters);
  const loadPinnedCharacters = useCharacterUIStore((s) => s.loadPinnedCharacters);
  const savePinnedCharacters = useCharacterUIStore((s) => s.savePinnedCharacters);
  const removePinnedCharacter = useCharacterUIStore((s) => s.removePinnedCharacter);

  // 追踪上一次已清理的无效 ID，避免重复清理导致循环
  const lastCleanedIdsRef = useRef<string>('');

  // 项目切换/首次进入时刷新角色索引与项目 pins
  useEffect(() => {
    if (!nodeGraphId) return;
    lastCleanedIdsRef.current = '';
    void loadCharacters();
    void loadPinnedCharacters();
  }, [nodeGraphId, loadCharacters, loadPinnedCharacters]);

  const characterMap = useMemo(() => {
    const map = new Map<string, (typeof characterIndexItems)[number]>();
    for (const item of characterIndexItems) {
      map.set(item.id, item);
    }
    return map;
  }, [characterIndexItems]);

  // 自动清理无效 ID（角色已被删除）
  useEffect(() => {
    if (!hasLoaded) return;
    if (!lastCharacterIndexLoadOk) return;
    if (isLoading) return;
    if (pinsLoading) return;
    if (!lastPinsLoadOk) return;
    if (pinnedCharacterIds.length === 0) {
      lastCleanedIdsRef.current = '';
      return;
    }
    const validIds = pinnedCharacterIds.filter((id) => characterMap.has(id));
    const invalidIds = pinnedCharacterIds.filter((id) => !characterMap.has(id));
    if (invalidIds.length === 0) return;

    const invalidKey = invalidIds.slice().sort().join(',');
    if (lastCleanedIdsRef.current === invalidKey) return;
    lastCleanedIdsRef.current = invalidKey;

    // 避免在 render 阶段直接触发 store 更新
    setTimeout(() => {
      void savePinnedCharacters(validIds);
      setSelectedCharacters(validIds);
    }, 0);
  }, [
    hasLoaded,
    lastCharacterIndexLoadOk,
    isLoading,
    pinsLoading,
    lastPinsLoadOk,
    pinnedCharacterIds,
    characterMap,
    savePinnedCharacters,
    setSelectedCharacters,
  ]);

  // 填充空位到 10 个
  const displaySlots = useMemo(() => {
    const slots: Array<string | null> = [...pinnedCharacterIds];
    while (slots.length < MAX_AVATAR_DISPLAY_COUNT) {
      slots.push(null);
    }
    return slots.slice(0, MAX_AVATAR_DISPLAY_COUNT);
  }, [pinnedCharacterIds]);

  const handleRemoveCharacter = useCallback(
    (characterId: string) => {
      void removePinnedCharacter(characterId);
      setSelectedCharacters(pinnedCharacterIds.filter((id) => id !== characterId));
    },
    [removePinnedCharacter, pinnedCharacterIds, setSelectedCharacters]
  );

  const handleSlotClick = useCallback(
    (characterId: string | null, characterName: string | undefined) => {
      if (!characterId) {
        openLibrary();
        return;
      }
      startPlacement(characterId, characterName || '角色');
    },
    [openLibrary, startPlacement]
  );

  return (
    <div
      className={cn(
        'flex items-end gap-2 px-4 py-2',
        'bg-background/80 rounded-full',
        'border shadow-lg',
        'z-canvas-banner'
      )}
    >
      {displaySlots.map((characterId, index) => {
        const character = characterId ? characterMap.get(characterId) : null;
        const characterName =
          character !== null && character !== undefined ? character.name : undefined;
        const characterDescription =
          character !== null && character !== undefined
            ? character.description
            : undefined;
        const characterImageUrl =
          character !== null && character !== undefined ? character.imageUrl : undefined;
        return (
          <CharacterAvatar
            key={characterId || `empty-${index}`}
            characterId={characterId}
            characterName={characterName}
            characterDescription={characterDescription}
            characterImageUrl={characterImageUrl}
            showRemove={!!characterId}
            onRemove={characterId ? () => handleRemoveCharacter(characterId) : () => undefined}
            onClick={() => handleSlotClick(characterId, characterName)}
            disableHoverZoom={false}
            className={undefined}
          />
        );
      })}

      <Button
        variant="ghost"
        size="icon"
        className="w-12 h-12"
        onClick={openLibrary}
        title="打开角色库"
      >
        <IconDots className="w-5 h-5" />
      </Button>

      {migrationPending ? (
        <span className="text-xs text-muted-foreground">角色库还没加载出来，正在重试…</span>
      ) : null}
    </div>
  );
}
