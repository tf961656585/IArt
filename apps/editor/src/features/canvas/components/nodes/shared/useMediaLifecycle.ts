'use client';

import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { mediaLifecycleManager, type MediaType } from '../../../services/mediaLifecycleManager';

export const useMediaLifecycle = (
  lifecycleKey: string | undefined | null,
  sourceUrl: string | undefined | null,
  type: MediaType,
) => {
  const normalizedKey = useMemo(
    () => (typeof lifecycleKey === 'string' ? lifecycleKey.trim() : ''),
    [lifecycleKey],
  );
  const normalizedUrl = useMemo(
    () => (typeof sourceUrl === 'string' ? sourceUrl.trim() : ''),
    [sourceUrl],
  );

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!normalizedKey) return () => {};
      return mediaLifecycleManager.subscribe(normalizedKey, onStoreChange);
    },
    [normalizedKey],
  );

  const getSnapshot = useCallback(() => {
    if (!normalizedKey) return 'active';
    return mediaLifecycleManager.getState(normalizedKey);
  }, [normalizedKey]);

  const state = useSyncExternalStore(subscribe, getSnapshot, () => 'dormant');

  // NOTE: 使用 layout effect 确保 register 在首次 paint 前完成，避免 hover 事件早于 register 导致激活丢失。
  useLayoutEffect(() => {
    if (!normalizedKey || !normalizedUrl) return;
    mediaLifecycleManager.register(normalizedKey, normalizedUrl, type);
    return () => {
      mediaLifecycleManager.setPlaying(normalizedKey, false);
      mediaLifecycleManager.onHoverLeave(normalizedKey);
      mediaLifecycleManager.unregister(normalizedKey);
    };
  }, [normalizedKey, normalizedUrl, type]);

  const onHoverEnter = useCallback(() => {
    if (!normalizedKey || !normalizedUrl) return;
    mediaLifecycleManager.onHoverEnter(normalizedKey);
  }, [normalizedKey, normalizedUrl]);

  const onHoverLeave = useCallback(() => {
    if (!normalizedKey || !normalizedUrl) return;
    mediaLifecycleManager.onHoverLeave(normalizedKey);
  }, [normalizedKey, normalizedUrl]);

  const setPlaying = useCallback(
    (playing: boolean) => {
      if (!normalizedKey || !normalizedUrl) return;
      mediaLifecycleManager.setPlaying(normalizedKey, playing);
    },
    [normalizedKey, normalizedUrl],
  );

  return {
    state,
    isActive: state === 'active',
    isDormant: state === 'dormant',
    onHoverEnter,
    onHoverLeave,
    setPlaying,
  };
};

export default useMediaLifecycle;
