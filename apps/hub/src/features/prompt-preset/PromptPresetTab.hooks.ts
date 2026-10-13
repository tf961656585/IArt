import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHubRuntime } from '../../components/providers/HubAppProvider';
import { copyText } from '../../client/utils/clipboard';

/** 预设记录（口径对齐 vanilla features/prompt-preset 的 normalizePromptPresetRecord 产物） */
export interface PromptPresetRecord {
  id: string | number | null | undefined;
  name: string | null | undefined;
  content: string | null | undefined;
  updatedAt: string | number | Date | null | undefined;
}

export interface SavePromptPresetPayload {
  id: string | undefined;
  name: string;
  content: string;
}

/** 删除二次确认超时（等价 vanilla promptPresetDeleteConfirmTimer 的 3000ms） */
const DELETE_CONFIRM_TIMEOUT_MS = 3000;

/**
 * prompt-preset 域 React 版操作 hook。逻辑与 vanilla 侧 createPromptPresetController
 * （controllers/prompt-preset-controller.ts）等价：列表/搜索/加载状态为组件内 state
 * （预设列表只在 prompt-preset tab 消费，无跨组件刷新触发，不入全局 hub-store），
 * 过程提示写入本地 statusMessage（对应 vanilla 的 promptPresetStatus）。
 */
export function usePromptPresets() {
  const { promptPresetFeature } = useHubRuntime();
  const [presets, setPresets] = useState<PromptPresetRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('正在读取预设...');
  const [deleteConfirmId, setDeleteConfirmId] = useState('');
  const deleteConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingRef = useRef(false);

  const resetDeleteConfirm = useCallback((): void => {
    setDeleteConfirmId('');
    if (deleteConfirmTimerRef.current !== null) {
      clearTimeout(deleteConfirmTimerRef.current);
      deleteConfirmTimerRef.current = null;
    }
  }, []);

  // 卸载时清理删除确认定时器，避免卸载后 setState
  useEffect(() => {
    return () => {
      if (deleteConfirmTimerRef.current !== null) clearTimeout(deleteConfirmTimerRef.current);
    };
  }, []);

  /** 加载预设列表（vanilla loadPromptPresets；silent=true 时不显示“正在加载”提示） */
  const loadPresets = useCallback(
    async (silent: boolean = false): Promise<void> => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      resetDeleteConfirm();
      try {
        if (!silent) setStatusMessage('正在读取预设...');
        const data = await promptPresetFeature.loadPresets();
        const list: PromptPresetRecord[] = Array.isArray(data.presets) ? data.presets : [];
        setPresets(list);
        setError(null);
        setStatusMessage(data.message || '共 ' + list.length + ' 条预设');
      } catch (loadError: unknown) {
        console.error('[hub] loadPromptPresets error:', loadError);
        setError('没能读取预设，请重试');
        setStatusMessage('没能读取预设，请重试');
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [promptPresetFeature, resetDeleteConfirm],
  );

  /** 创建/编辑预设（vanilla savePromptPresetFromModal；返回是否成功，失败时弹窗保持打开） */
  const savePreset = useCallback(
    async (payload: SavePromptPresetPayload): Promise<boolean> => {
      const name: string = String(payload.name || '').trim();
      const content: string = String(payload.content || '').trim();
      if (!name || !content) {
        setStatusMessage('请填写名称与提示词内容');
        return false;
      }

      const isEdit: boolean = Boolean(payload.id);
      try {
        const data = await promptPresetFeature.savePreset({
          id: isEdit ? payload.id : undefined,
          name,
          content,
        });
        await loadPresets(true);
        setStatusMessage(data.message || (isEdit ? '预设已更新' : '预设已创建'));
        return true;
      } catch (saveError: unknown) {
        console.error('[hub] savePromptPreset error:', saveError);
        setStatusMessage('没能保存，请重试');
        return false;
      }
    },
    [loadPresets, promptPresetFeature],
  );

  /** 删除预设（vanilla deleteBtn 确认后的删除分支） */
  const confirmDelete = useCallback(
    async (presetId: string): Promise<void> => {
      resetDeleteConfirm();
      try {
        setStatusMessage('正在删除预设...');
        const data = await promptPresetFeature.deletePreset(presetId);
        setPresets((prev: PromptPresetRecord[]) =>
          prev.filter((item: PromptPresetRecord) => item && String(item.id || '') !== presetId),
        );
        setStatusMessage(data.message || '已删除预设');
      } catch (deleteError: unknown) {
        console.error('[hub] deletePromptPreset error:', deleteError);
        setStatusMessage('没能删除，请重试');
      }
    },
    [promptPresetFeature, resetDeleteConfirm],
  );

  /** 删除入口：首次点击进入二次确认，3s 内再次点击执行删除（vanilla 删除确认交互） */
  const requestDelete = useCallback(
    (presetId: string): void => {
      if (!presetId) return;
      if (deleteConfirmId === presetId) {
        void confirmDelete(presetId);
        return;
      }
      setDeleteConfirmId(presetId);
      if (deleteConfirmTimerRef.current !== null) clearTimeout(deleteConfirmTimerRef.current);
      deleteConfirmTimerRef.current = setTimeout(() => {
        resetDeleteConfirm();
      }, DELETE_CONFIRM_TIMEOUT_MS);
    },
    [confirmDelete, deleteConfirmId, resetDeleteConfirm],
  );

  /** 复制预设内容到剪贴板 */
  const copyPreset = useCallback(async (preset: PromptPresetRecord): Promise<void> => {
    const copied: boolean = await copyText(preset.content ? String(preset.content) : '');
    setStatusMessage(copied ? '已复制到剪贴板' : '没能复制，请重试');
  }, []);

  /** 搜索过滤（vanilla renderPromptPresets 的 query 过滤逻辑） */
  const filteredPresets: PromptPresetRecord[] = useMemo(() => {
    const query: string = searchTerm.trim().toLowerCase();
    if (!query) return presets;
    return presets.filter((preset: PromptPresetRecord) => {
      const name: string = preset.name ? String(preset.name).toLowerCase() : '';
      const content: string = preset.content ? String(preset.content).toLowerCase() : '';
      return name.includes(query) || content.includes(query);
    });
  }, [presets, searchTerm]);

  return {
    presets,
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
  };
}
