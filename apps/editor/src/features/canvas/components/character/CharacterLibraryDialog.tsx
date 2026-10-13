'use client';

/**
 * 角色库弹窗
 * - 查看所有角色
 * - 搜索角色
 * - 勾选添加到当前项目
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { IconSearch, IconX } from '@tabler/icons-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CharacterCard } from './CharacterCard';
import { EditCharacterDialog } from './EditCharacterDialog';
import { useCharacterUIStore } from '../../store/characterUIStore';
import { useCanvasStore } from '../../store/canvasStore';
import { CharacterStore } from '../../services/characterStore';
import { MAX_AVATAR_DISPLAY_COUNT } from '../../types/character';
import type { CharacterIndexItem } from '../../types/character';

export function CharacterLibraryDialog() {
  const libraryOpen = useCharacterUIStore((s) => s.libraryOpen);
  const closeLibrary = useCharacterUIStore((s) => s.closeLibrary);
  const characters = useCharacterUIStore((s) => s.characters);
  const isLoading = useCharacterUIStore((s) => s.isLoading);
  const pinsLoading = useCharacterUIStore((s) => s.pinsLoading);
  const migrationPending = useCharacterUIStore((s) => s.migrationPending);
  const pinnedCharacterIds = useCharacterUIStore((s) => s.pinnedCharacterIds);
  const refreshAfterDelete = useCharacterUIStore((s) => s.refreshAfterDelete);
  const loadCharacters = useCharacterUIStore((s) => s.loadCharacters);
  const savePinnedCharacters = useCharacterUIStore((s) => s.savePinnedCharacters);
  const removePinnedCharacter = useCharacterUIStore((s) => s.removePinnedCharacter);
  const loadPinnedCharacters = useCharacterUIStore((s) => s.loadPinnedCharacters);

  const setSelectedCharacters = useCanvasStore((s) => s.setSelectedCharacters);

  const [searchQuery, setSearchQuery] = useState('');
  const [localSelection, setLocalSelection] = useState<Set<string>>(new Set());

  // 编辑弹窗状态
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingCharacter, setEditingCharacter] = useState<CharacterIndexItem | null>(null);

  // 删除确认弹窗状态
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingCharacterId, setDeletingCharacterId] = useState<string | null>(null);

  // 打开弹窗时初始化本地选择状态
  useEffect(() => {
    if (libraryOpen) {
      setLocalSelection((prev) => {
        if (prev.size === pinnedCharacterIds.length) {
          let same = true;
          for (const id of pinnedCharacterIds) {
            if (!prev.has(id)) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return new Set(pinnedCharacterIds);
      });
      setSearchQuery('');
    }
  }, [libraryOpen, pinnedCharacterIds]);

  useEffect(() => {
    if (!libraryOpen) return;
    void loadPinnedCharacters();
  }, [libraryOpen, loadPinnedCharacters]);

  // 筛选角色
  const filteredCharacters = useMemo(() => {
    let result = characters;

    // 名称搜索
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((c) => c.name.toLowerCase().includes(query));
    }

    return result;
  }, [characters, searchQuery]);

  // 切换单个角色选中状态
  const handleToggleSelection = useCallback((characterId: string, selected: boolean) => {
    setLocalSelection((prev) => {
      const next = new Set(prev);
      if (selected) {
        // 检查是否超过最大数量
        if (next.size >= MAX_AVATAR_DISPLAY_COUNT) {
          toast.error(`最多只能选择 ${MAX_AVATAR_DISPLAY_COUNT} 个角色`);
          return prev;
        }
        next.add(characterId);
      } else {
        next.delete(characterId);
      }
      return next;
    });
  }, []);

  // 编辑角色
  const handleEdit = useCallback((character: CharacterIndexItem) => {
    setEditingCharacter(character);
    setEditDialogOpen(true);
  }, []);

  // 删除角色确认
  const handleDeleteConfirm = useCallback((characterId: string) => {
    setDeletingCharacterId(characterId);
    setDeleteDialogOpen(true);
  }, []);

  // 执行删除
  const handleDeleteExecute = useCallback(async () => {
    if (!deletingCharacterId) return;

    try {
      await CharacterStore.delete(deletingCharacterId);
      await refreshAfterDelete(deletingCharacterId);

      // 删除后：应立即从当前项目固定角色中移除，Phase A 继续双写 selectedCharacterIds
      if (pinnedCharacterIds.includes(deletingCharacterId)) {
        const nextPinned = pinnedCharacterIds.filter((id) => id !== deletingCharacterId);
        await removePinnedCharacter(deletingCharacterId);
        setSelectedCharacters(nextPinned);
      }

      // 从本地选择中移除
      setLocalSelection((prev) => {
        const next = new Set(prev);
        next.delete(deletingCharacterId);
        return next;
      });

      toast.success('角色已删除');
    } catch (error) {
      console.error('[CharacterLibraryDialog] 删除失败', error);
      toast.error('删除失败');
    } finally {
      setDeleteDialogOpen(false);
      setDeletingCharacterId(null);
    }
  }, [
    deletingCharacterId,
    pinnedCharacterIds,
    refreshAfterDelete,
    removePinnedCharacter,
    setSelectedCharacters,
  ]);

  // 确认选择
  const handleConfirm = useCallback(async () => {
    const nextPinned = Array.from(localSelection);
    await savePinnedCharacters(nextPinned);
    setSelectedCharacters(nextPinned);
    closeLibrary();
    toast.success('角色预设已更新');
  }, [localSelection, savePinnedCharacters, setSelectedCharacters, closeLibrary]);

  // 编辑完成后刷新
  const handleEditComplete = useCallback(() => {
    setEditDialogOpen(false);
    setEditingCharacter(null);
    void loadCharacters();
  }, [loadCharacters]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeLibrary();
      }
    },
    [closeLibrary]
  );

  return (
    <>
      <Dialog open={libraryOpen} onOpenChange={handleOpenChange}>
        <DialogContent form="standard" size="wide">
          <DialogHeader>
            <DialogTitle>角色库</DialogTitle>
            <DialogDescription>
              选择角色添加到当前项目的预设中（最多 {MAX_AVATAR_DISPLAY_COUNT} 个）
            </DialogDescription>
          </DialogHeader>

          {/* 搜索栏 */}
          <div className="flex gap-3 py-2">
            <div className="flex-1 relative">
              <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="搜索角色名称..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-9"
              />
              {searchQuery && (
                <button
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setSearchQuery('')}
                >
                  <IconX className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* 角色列表 */}
          <DialogBody variant="scroll" className="-mx-6 px-6">
            {isLoading || pinsLoading ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-muted-foreground">
                  {migrationPending ? '还没加载出来，正在重试…' : '加载中...'}
                </p>
              </div>
            ) : filteredCharacters.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="text-muted-foreground">
                  {searchQuery.trim()
                    ? '没有找到匹配的角色'
                    : '角色库为空，从图片节点右键菜单保存角色'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-3 pb-4">
                {filteredCharacters.map((character) => (
                  <CharacterCard
                    key={character.id}
                    character={character}
                    selected={localSelection.has(character.id)}
                    onSelectedChange={(selected) =>
                      handleToggleSelection(character.id, selected)
                    }
                    onEdit={handleEdit}
                    onDelete={handleDeleteConfirm}
                  />
                ))}
              </div>
            )}
          </DialogBody>

          {/* 底部信息和按钮 */}
          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <p className="text-sm text-muted-foreground">
              已选择 {localSelection.size} / {MAX_AVATAR_DISPLAY_COUNT} 个角色
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={closeLibrary}>
                取消
              </Button>
              <Button onClick={handleConfirm}>确定</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑角色弹窗 */}
      {editingCharacter && (
        <EditCharacterDialog
          open={editDialogOpen}
          character={editingCharacter}
          onOpenChange={setEditDialogOpen}
          onComplete={handleEditComplete}
        />
      )}

      {/* 删除确认弹窗 */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent form="standard" size="compact">
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              删除后将从当前项目的角色库与预设中移除此角色，此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteExecute}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
