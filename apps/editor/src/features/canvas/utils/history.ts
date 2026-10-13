import { useCanvasStore } from '../store/canvasStore';

export const scheduleHistorySave = (startHistoryIndex: number): void => {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    const state = useCanvasStore.getState();
    if (state.historyIndex === startHistoryIndex) {
      state.saveToHistory();
    }
  }, 0);
};
