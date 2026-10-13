import { useEffect, useState } from 'react';
import { Button, Input } from '@iart/ui';
import { MessageSquare, Plus, RefreshCw } from 'lucide-react';
import { usePromptPresets, type PromptPresetRecord, type SavePromptPresetPayload } from './PromptPresetTab.hooks';
import { PromptPresetDialog } from './PromptPresetDialog';
import { PresetItem } from './PresetItem';
import { HubTopBand } from '../../components/HubTopBand';

interface DialogState {
  open: boolean;
  preset: PromptPresetRecord | null;
}

export function PromptPresetTab() {
  const {
    filteredPresets,
    loading,
    searchTerm,
    setSearchTerm,
    error,
    statusMessage,
    deleteConfirmId,
    loadPresets,
    savePreset,
    requestDelete,
    copyPreset,
  } = usePromptPresets();
  const [dialog, setDialog] = useState<DialogState>({ open: false, preset: null });

  // 进入 tab 时加载预设列表（等价 vanilla onPromptsTabActivated → loadPromptPresets）
  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  const openCreateDialog = (): void => {
    setDialog({ open: true, preset: null });
  };

  const openEditDialog = (preset: PromptPresetRecord): void => {
    setDialog({ open: true, preset });
  };

  const handleSave = async (payload: SavePromptPresetPayload): Promise<boolean> => {
    const ok: boolean = await savePreset(payload);
    if (ok) setDialog({ open: false, preset: null });
    return ok;
  };

  const statusText: string = error !== null ? error : statusMessage;
  const emptyText: string = searchTerm.trim() ? '没有匹配的预设' : '还没有预设，先创建一个吧';

  return (
    <div className="flex h-full w-full flex-col">
      {/* 顶栏带（spec docs/hub/window-chrome.md §6.1/§6.3）：标题 + muted 副标题行内 */}
      <HubTopBand>
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-semibold">提示词预设</h1>
          <span className="text-sm text-muted-foreground">管理可复用的提示词</span>
        </div>
      </HubTopBand>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <Input
          value={searchTerm}
          placeholder="搜索名称或内容..."
          className="max-w-xs"
          onChange={(event) => setSearchTerm(event.target.value)}
        />
        <Button onClick={openCreateDialog}>
          <Plus /> 新增预设
        </Button>
        <Button variant="outline" onClick={() => void loadPresets(true)}>
          <RefreshCw /> 刷新
        </Button>
      </div>
      <div className="flex shrink-0 items-center border-b border-border px-4 py-1 text-xs">
        {error !== null ? (
          <span className="text-destructive">{statusText}</span>
        ) : (
          <span className="text-muted-foreground">{statusText}</span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading && filteredPresets.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">正在读取预设...</div>
        ) : filteredPresets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <MessageSquare className="h-10 w-10 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">{emptyText}</div>
            <Button onClick={openCreateDialog}>
              <Plus /> 新增预设
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filteredPresets.map((preset) => {
              const presetId: string = preset.id ? String(preset.id) : '';
              return (
                <PresetItem
                  key={presetId}
                  preset={preset}
                  isDeleteConfirming={!!presetId && deleteConfirmId === presetId}
                  onCopy={() => void copyPreset(preset)}
                  onEdit={() => openEditDialog(preset)}
                  onDelete={() => requestDelete(presetId)}
                />
              );
            })}
          </div>
        )}
      </div>
      <PromptPresetDialog
        open={dialog.open}
        preset={dialog.preset}
        onOpenChange={(open) => setDialog((s) => ({ ...s, open }))}
        onSave={handleSave}
      />
    </div>
  );
}
