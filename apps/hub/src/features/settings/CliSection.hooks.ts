import { useCallback, useEffect, useRef, useState } from 'react';
import type { CliCommandLogEntry, CliEntryStatusDetail, CliStatusDto } from '@iart/contracts';
import { useHubRuntime } from '../../components/providers/HubAppProvider';

/**
 * 设置页「命令行工具」子单元操作 hook（spec docs/integrations/CLI与本地Agent集成.md §8）：
 * 挂载时经 `cli:get-status` 只读读取一次状态；注册/卸除动作幂等（CLI-016），
 * 成功后重读状态让注册状态行即时更新；结果消息（成功与失败）在子单元内显示（Hub 无 toast）。
 * 后端返回的 message 面向用户（CliEntryOperationResult 契约口径），直接展示；
 * IPC 异常原文只进日志，界面给兜底文案。
 */

/** 命令入口动作进行中标记（同一时刻至多一个动作在途） */
export type CliEntryAction = 'register' | 'unregister';

/** 动作结果提示（成功为中性呈现，失败为警示呈现） */
export type CliEntryNotice = { kind: 'success' | 'error'; text: string };

const REGISTER_FALLBACK_MESSAGE = '没能注册 iart 命令，请重试';
const UNREGISTER_FALLBACK_MESSAGE = '没能卸除注册，请重试';

export function useCliSection() {
  const { platform } = useHubRuntime();

  const [status, setStatus] = useState<CliStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<CliEntryAction | null>(null);
  const [notice, setNotice] = useState<CliEntryNotice | null>(null);

  const mountedRef = useRef(true);

  /** 重读状态（挂载时 + 注册/卸除成功后） */
  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const dto = await platform.getCliStatus();
      if (!mountedRef.current) return;
      if (dto === null) {
        setLoadFailed(true);
      } else {
        setStatus(dto);
        setLoadFailed(false);
      }
    } catch (error: unknown) {
      console.debug('[cli] getCliStatus 失败:', error);
      if (mountedRef.current) setLoadFailed(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  /** 命令入口注册/卸除（幂等）：成功后重读状态，结果消息（含 PATH 引导）在子单元内展示 */
  const runEntryAction = useCallback(
    async (action: CliEntryAction): Promise<void> => {
      if (pending !== null) return;
      setPending(action);
      setNotice(null);
      try {
        const result =
          action === 'register' ? await platform.registerCliEntry() : await platform.unregisterCliEntry();
        if (!mountedRef.current) return;
        if (result.ok) {
          if (result.message != null) {
            setNotice({ kind: 'success', text: result.message });
          }
          await refresh();
        } else {
          setNotice({
            kind: 'error',
            text: result.message ?? (action === 'register' ? REGISTER_FALLBACK_MESSAGE : UNREGISTER_FALLBACK_MESSAGE),
          });
        }
      } catch (error: unknown) {
        console.debug('[cli] 入口操作失败:', error);
        if (mountedRef.current) {
          setNotice({
            kind: 'error',
            text: action === 'register' ? REGISTER_FALLBACK_MESSAGE : UNREGISTER_FALLBACK_MESSAGE,
          });
        }
      } finally {
        if (mountedRef.current) setPending(null);
      }
    },
    [pending, platform, refresh],
  );

  return {
    status,
    loading,
    loadFailed,
    pending,
    notice,
    refresh,
    register: useCallback(() => runEntryAction('register'), [runEntryAction]),
    unregister: useCallback(() => runEntryAction('unregister'), [runEntryAction]),
  };
}

/** 注册状态五态的用户可见词（spec §8 五态；文案经 ui-copy-check 对抗性复审） */
export const entryStateText = (entry: CliEntryStatusDetail): string => {
  switch (entry.state) {
    case 'registered':
      return '已注册';
    case 'missing':
      return '未注册';
    case 'stale':
      return '已失效';
    case 'foreign':
      return '已被其他程序占用';
    case 'unsupported':
      return '当前平台暂不支持一键注册';
  }
};

/**
 * 注册状态随行提示（spec §8 五态说明 / 旧入口遮蔽 / PATH 引导）：
 * 每条都是「处境 + 出路」；正常态（无旧入口、无需配 PATH）不印，避免噪音。
 */
export const entryGuidanceLines = (entry: CliEntryStatusDetail): string[] => {
  const lines: string[] = [];
  if (entry.state === 'stale') {
    lines.push('已有的 iart 命令指向旧版本或旧位置，重新注册后就能继续使用。');
  }
  if (entry.state === 'foreign') {
    lines.push('已有一个不是本应用创建的 iart 命令；注册后它会被替换。');
  }
  if (entry.legacyEntryPath !== null) {
    lines.push(
      `在 ${entry.legacyEntryPath} 还有一个 iart 命令，终端可能会优先使用它。` +
        `如果它是你以前自己创建的，可以在终端执行 sudo rm ${entry.legacyEntryPath} 删除。`,
    );
  }
  if (entry.pathSetupRequired && entry.entryPath !== null && entry.state !== 'missing') {
    const dir = entry.entryPath.replace(/[\\/][^\\/]*$/, '');
    lines.push(`如果终端提示找不到 iart 命令，请把 ${dir} 加入 PATH，然后在终端重新输入 iart。`);
  }
  return lines;
};

/** 耗时展示：满 1 秒以秒计（一位小数），不足 1 秒以毫秒计 */
export const formatCommandDuration = (durationMs: number): string =>
  durationMs >= 1000 ? (durationMs / 1000).toFixed(1) + ' 秒' : Math.round(durationMs) + ' ms';

/** 日志条目状态的用户可见词 */
export const commandStatusText = (entry: Pick<CliCommandLogEntry, 'status'>): string =>
  entry.status === 'success' ? '成功' : '失败';
