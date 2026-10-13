import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubConfigResponse } from '@iart/contracts';
import { useHubRuntime } from '../../components/providers/HubAppProvider';

/**
 * 运行策略子域 React 版操作 hook。逻辑与 vanilla 侧 createSettingsController
 * （controllers/settings-controller.ts）等价：
 * - 进入设置 tab 时 loadSettings 读取配置（等价 vanilla onSettingsTabActivated）；
 * - maxBatchTasks / expandInlineParamsOnStartup 变更均走 debounce 300ms 自动保存
 *   （等价 vanilla change 事件 → debouncedSave）；
 * - maxBatchTasks 的 wheel 调整（±1，shift 时 ±5，最小 1，空值按 30 起算）
 *   用原生 addEventListener + passive:false 实现——React 合成 onWheel 是
 *   被动监听，preventDefault 不生效；
 * - 保存成功后以返回的 config 重新应用表单值（等价 vanilla applySettings）。
 * statusMessage 仅承载错误留痕（读取/保存失败），成功路径静默。
 */

export const DEFAULT_MAX_BATCH_TASKS = 30;

const parseMaxBatchTasks = (raw: string | undefined): number => {
  const parsed: number = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BATCH_TASKS;
};

export function useRunPolicy() {
  const { settingsFeature } = useHubRuntime();

  const [maxBatchTasks, setMaxBatchTasks] = useState(String(DEFAULT_MAX_BATCH_TASKS));
  const [expandInlineParamsOnStartup, setExpandInlineParamsOnStartup] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // wheel 处理在组件里以原生 listener（passive:false）挂一次，值经 ref 镜像读取，避免闭包过期
  const maxBatchTasksRef = useRef(String(DEFAULT_MAX_BATCH_TASKS));
  const syncMaxBatchTasksRef = (value: string): void => {
    maxBatchTasksRef.current = value;
  };

  /** 以配置响应回填表单（等价 vanilla applySettings） */
  const applySettings = useCallback((payload: HubConfigResponse | null | undefined): void => {
    if (!payload) return;
    const config = payload.config;
    const resolvedMaxBatchTasks = String(parseMaxBatchTasks(config.maxBatchTasks !== undefined ? String(config.maxBatchTasks) : ''));
    setMaxBatchTasks(resolvedMaxBatchTasks);
    syncMaxBatchTasksRef(resolvedMaxBatchTasks);
    setExpandInlineParamsOnStartup(config.expandInlineParamsOnStartup === true);
  }, []);

  /** 读取配置（进入设置 tab；等价 vanilla loadSettings。force 参数为兼容保留） */
  const loadSettings = useCallback(
    async (_force: boolean | undefined): Promise<void> => {
      try {
        const payload: HubConfigResponse = await settingsFeature.loadSettings(undefined);
        applySettings(payload);
      } catch {
        setStatusMessage('没能读取设置，请重试');
      }
    },
    [applySettings, settingsFeature],
  );

  /** 保存当前表单值（等价 vanilla saveSettings；成功静默，失败留痕）。 */
  const saveSettings = useCallback(async (): Promise<void> => {
    const parsed: number = Number.parseInt(String(maxBatchTasks ?? ''), 10);
    try {
      const payload: HubConfigResponse = await settingsFeature.saveSettings({
        maxBatchTasks: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
        expandInlineParamsOnStartup,
      });
      applySettings(payload);
    } catch {
      setStatusMessage('没能保存，请重试');
    }
  }, [applySettings, expandInlineParamsOnStartup, maxBatchTasks, settingsFeature]);

  /** 表单变更触发 debounce 300ms 自动保存（等价 vanilla debouncedSave） */
  const debouncedSave = useCallback((): void => {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveSettings();
    }, 300);
  }, [saveSettings]);

  /** wheel 调整 maxBatchTasks：shift 步长 5，否则 1，最小 1，空值按 30 起算（经 ref 读取当前值） */
  const handleMaxBatchTasksWheel = useCallback((event: WheelEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const step: number = event.shiftKey ? 5 : 1;
    const delta: number = event.deltaY > 0 ? -step : step;
    const current: number = Number.parseInt(String(maxBatchTasksRef.current ?? ''), 10);
    const base: number = Number.isFinite(current) && current > 0 ? current : DEFAULT_MAX_BATCH_TASKS;
    const next: string = String(Math.max(1, base + delta));
    setMaxBatchTasks(next);
    syncMaxBatchTasksRef(next);
  }, []);

  /** maxBatchTasks 变更：更新值 + debounce 保存（等价 vanilla change → debouncedSave） */
  const changeMaxBatchTasks = useCallback(
    (value: string): void => {
      setMaxBatchTasks(value);
      syncMaxBatchTasksRef(value);
      debouncedSave();
    },
    [debouncedSave],
  );

  /** 启动参数开关变更：更新值 + debounce 保存 */
  const changeExpandInlineParamsOnStartup = useCallback(
    (enabled: boolean): void => {
      setExpandInlineParamsOnStartup(enabled);
      debouncedSave();
    },
    [debouncedSave],
  );

  /** 卸载时清理挂起的 debounce 定时器 */
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    };
  }, []);

  return {
    maxBatchTasks,
    expandInlineParamsOnStartup,
    statusMessage,
    loadSettings,
    handleMaxBatchTasksWheel,
    changeMaxBatchTasks,
    changeExpandInlineParamsOnStartup,
  };
}
