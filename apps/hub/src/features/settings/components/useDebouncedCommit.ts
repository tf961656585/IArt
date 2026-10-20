import { useCallback, useEffect, useRef } from 'react';

/**
 * 防抖提交钩子（设置页表单族的共享实现）。
 *
 * 解决问题：设置页的多个表单子单元采用「编辑即自动保存」——变更后 300ms 提交，成功静默。
 * 分区成页后每个子单元是独立页面，**切换导航即卸载组件**。若卸载时简单 `clearTimeout`，
 * 用户在 300ms 内改完就切走，这次改动会静默丢失：界面已经显示新值，后端仍是旧值，
 * 而且没有任何提示。
 *
 * 裁定（2026-10-19）：卸载时**立即冲出挂起的提交**，而不是丢弃它。
 * 未挂起时不做事；冲出只做一次（不会因重复卸载重复提交）。
 *
 * 备选方案「把表单状态提升到页面之上」的代价更高：每个子单元都要把状态与校验逻辑上移，
 * 切页后还要持有全部表单状态。设置页是低频配置面，冲出挂起提交成本低得多。
 *
 * 用法：
 * ```ts
 * const schedule = useDebouncedCommit(() => { void persist(mode, url); });
 * const changeUrl = (v: string) => { setUrl(v); schedule(); };
 * ```
 * 提交函数每次渲染都可传入新闭包（内部经 ref 读取最新值），调用方不必为它写 useCallback。
 */
export const SETTINGS_COMMIT_DEBOUNCE_MS = 300;

export function useDebouncedCommit(
  commit: () => void,
  delayMs: number = SETTINGS_COMMIT_DEBOUNCE_MS,
): () => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 是否有挂起未提交的变更（定时器在跑） */
  const pendingRef = useRef(false);

  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  // 卸载时冲出挂起提交：分区切换会卸载整个页面，不能把已显示在界面上的改动丢掉
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (pendingRef.current) {
        pendingRef.current = false;
        commitRef.current();
      }
    };
  }, []);

  return useCallback(
    (): void => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      pendingRef.current = true;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        pendingRef.current = false;
        commitRef.current();
      }, delayMs);
    },
    [delayMs],
  );
}
