export type BackendTaskNotice = {
  type: 'backend_task_bypassed';
  reasonCode: string;
  reasonText: string;
  endpoint: string;
  useBackendTask: boolean;
  taskCreateDecision: 'bypass_backend_task';
  taskScope: string;
  projectPath: string | null;
  taskId: string | null;
};

type BackendTaskNoticeListener = (notice: BackendTaskNotice) => void;

const listeners = new Set<BackendTaskNoticeListener>();

export function onBackendTaskNotice(listener: BackendTaskNoticeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitBackendTaskNotice(notice: BackendTaskNotice): void {
  for (const listener of listeners) {
    try {
      listener(notice);
    } catch (error) {
      console.warn('[BackendTaskNoticeEmitter] listener failed', error);
    }
  }
}

export function clearBackendTaskNoticeListeners(): void {
  listeners.clear();
}
