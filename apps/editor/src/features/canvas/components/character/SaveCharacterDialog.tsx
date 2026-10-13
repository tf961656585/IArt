'use client';

/**
 * 保存角色弹窗
 * - 从图片节点保存角色到角色库
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import NextImage from 'next/image';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useCharacterUIStore } from '../../store/characterUIStore';
import { useCanvasStore } from '../../store/canvasStore';
import { CharacterStore } from '../../services/characterStore';
import { extractImageBlobFromImageNode } from '../../utils/mediaUtils';
import { MAX_AVATAR_DISPLAY_COUNT } from '../../types/character';
import type { GraphNode, ImageInputNodeData } from '../../types';

export function SaveCharacterDialog() {
  const saveDialogOpen = useCharacterUIStore((s) => s.saveDialogOpen);
  const saveDialogNodeId = useCharacterUIStore((s) => s.saveDialogNodeId);
  const closeSaveDialog = useCharacterUIStore((s) => s.closeSaveDialog);
  const refreshAfterAdd = useCharacterUIStore((s) => s.refreshAfterAdd);
  const pinnedCharacterIds = useCharacterUIStore((s) => s.pinnedCharacterIds);
  const appendPinnedCharacter = useCharacterUIStore((s) => s.appendPinnedCharacter);
  const migrationPending = useCharacterUIStore((s) => s.migrationPending);

  const nodeGraph = useCanvasStore((s) => s.nodeGraph);
  const setSelectedCharacters = useCanvasStore((s) => s.setSelectedCharacters);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [imageMimeType, setImageMimeType] = useState<string | null>(null);

  // 获取当前节点
  const currentNode = useMemo(() => {
    if (!saveDialogNodeId || !nodeGraph) return null;
    return nodeGraph.nodes.find((n) => n.id === saveDialogNodeId) as
      | GraphNode<ImageInputNodeData>
      | undefined
      | null;
  }, [saveDialogNodeId, nodeGraph]);

  // 获取当前项目信息
  const projectInfo = useMemo(() => {
    if (!nodeGraph) return { id: '', name: '未知项目' };
    return {
      id: nodeGraph.id,
      name: nodeGraph.name || '未命名画布',
    };
  }, [nodeGraph]);

  // 加载预览图
  useEffect(() => {
    if (!saveDialogOpen || !currentNode) {
      setPreviewUrl(null);
      setPreviewError(null);
      setImageBlob(null);
      setImageMimeType(null);
      return;
    }

    let objectUrl: string | null = null;
    let mounted = true;

    const loadPreview = async () => {
      setPreviewError(null);
      setImageBlob(null);
      setImageMimeType(null);
      const data = currentNode.data as ImageInputNodeData | undefined;
      const imageUrl = (data !== null && data !== undefined ? data.imageUrl : undefined) ?? null;
      const result = await extractImageBlobFromImageNode(imageUrl);
      if (!mounted) return;

      if (!result) {
        setPreviewUrl(null);
        setPreviewError('这张图片来自外部链接，暂时无法读取');
        return;
      }

      setImageBlob(result.blob);
      setImageMimeType(result.mimeType);
      objectUrl = URL.createObjectURL(result.blob);
      setPreviewUrl(objectUrl);
    };

    void loadPreview();

    return () => {
      mounted = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [saveDialogOpen, currentNode]);

  // 重置表单
  useEffect(() => {
    if (saveDialogOpen) {
      setName('');
      setDescription('');
      setIsSubmitting(false);
      setPreviewError(null);
    }
  }, [saveDialogOpen]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent | undefined) => {
      if (e !== null && e !== undefined) {
        e.preventDefault();
      }

      if (!name.trim()) {
        toast.error('请输入角色名称');
        return;
      }

      if (!currentNode) {
        toast.error('找不到这个节点了');
        return;
      }

      if (!imageBlob) {
        toast.error('图片还没准备好，请稍后再试');
        return;
      }

      setIsSubmitting(true);

      try {
        const characterId = await CharacterStore.add({
          name: name.trim(),
          description: description.trim(),
          imageData: imageBlob,
          mimeType: imageMimeType ?? imageBlob.type ?? 'image/png',
        });

        if (!characterId) {
          toast.error('保存失败');
          return;
        }

        // 刷新角色列表
        await refreshAfterAdd();

        // 检查当前项目固定角色数量（Phase A: pins + selectedCharacterIds 双写）
        if (pinnedCharacterIds.length < MAX_AVATAR_DISPLAY_COUNT) {
          await appendPinnedCharacter(characterId);
          const nextPinned = Array.from(
            new Set([...pinnedCharacterIds, characterId])
          ).slice(0, MAX_AVATAR_DISPLAY_COUNT);
          setSelectedCharacters(nextPinned);
          if (migrationPending) {
            toast.success('角色已保存，固定角色稍后会自动同步');
          } else {
            toast.success('角色已保存并添加到预设');
          }
        } else {
          toast.success('角色已保存到角色库，可通过"更多"按钮管理');
        }

        closeSaveDialog();
      } catch (error) {
        console.error('[SaveCharacterDialog] 保存失败', error);
        toast.error('保存失败，请稍后重试');
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      name,
      description,
	      currentNode,
	      closeSaveDialog,
      refreshAfterAdd,
      pinnedCharacterIds,
      appendPinnedCharacter,
      migrationPending,
      setSelectedCharacters,
      imageBlob,
      imageMimeType,
    ]
  );

  // closeOnEscape=false：模态禁 Esc（spec docs/editor/浮层堆栈管理.md 核心规则 5）——
  // Esc 由浮层栈消费但不关闭本弹窗，不再自挂 onEscapeKeyDown 拦截。
  return (
    <Dialog open={saveDialogOpen} closeOnEscape={false}>
      <DialogContent
        form="standard"
        size="compact"
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>保存角色</DialogTitle>
            <DialogDescription>
              将此图片保存为角色预设，方便在生成时复用
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-4">
            {/* 图片预览 */}
            <div className="flex-shrink-0 space-y-1">
              <div className="w-24 h-24 rounded-lg overflow-hidden bg-muted">
                {previewUrl ? (
	                  <NextImage
	                    src={previewUrl}
	                    alt="预览"
	                    className="w-full h-full object-cover"
	                    height={96}
	                    unoptimized
	                    width={96}
	                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
                    {previewError ? '无法加载' : '加载中...'}
                  </div>
                )}
              </div>
              {previewError && (
                <p className="text-xs text-destructive max-w-24 leading-snug">
                  {previewError}
                </p>
              )}
            </div>

            {/* 表单 */}
            <div className="flex-1 space-y-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">所属项目</Label>
                <p className="text-sm font-medium">{projectInfo.name}</p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="character-name">角色名称 *</Label>
                <Input
                  id="character-name"
	                  value={name}
	                  onChange={(e) => setName(e.target.value)}
	                  placeholder="输入角色名称"
	                  disabled={isSubmitting}
	                />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="character-description">角色描述</Label>
            <Textarea
              id="character-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="输入角色描述（可选）"
              rows={3}
              disabled={isSubmitting}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeSaveDialog}
              disabled={isSubmitting}
            >
              取消
            </Button>
            <Button type="submit" disabled={isSubmitting || !name.trim() || !imageBlob}>
              {isSubmitting ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
