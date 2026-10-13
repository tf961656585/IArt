import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { flushAllPending } from './useAutoSave';

/**
 * 渲染进程端关闭协议 hook。
 * 监听主进程发来的 editor:prepare-close IPC 消息，
 * 无条件 flush 确保所有数据落盘后回复 close-ready。
 */
export function useCloseProtocol() {
  const flushingRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const electron = (window as {
      electron: {
        onPrepareClose: (callback: () => void) => void | undefined;
        removePrepareCloseListener: () => void | undefined;
        sendCloseReady: () => void | undefined;
        sendCloseError: (error: unknown) => void | undefined;
      } | undefined;
    }).electron;
    if (!electron || !electron.onPrepareClose) return undefined;

    const handleClose = async () => {
      if (flushingRef.current) return;

      flushingRef.current = true;
      useCanvasStore.getState().setClosing(true);
      try {
        await flushAllPending();
        if (electron.sendCloseReady) {
          electron.sendCloseReady();
        }
      } catch (error) {
        console.error('[useCloseProtocol] flush failed', error);
        if (electron.sendCloseError) {
          electron.sendCloseError(error);
        }
      } finally {
        flushingRef.current = false;
      }
    };

    electron.onPrepareClose(handleClose);

    return () => {
      if (electron.removePrepareCloseListener) {
        electron.removePrepareCloseListener();
      }
    };
  }, []);
}
