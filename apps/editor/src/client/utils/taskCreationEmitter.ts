/**
 * Global task acceptance event emitter for task recovery.
 * Used to notify when a backend task is accepted before completion.
 */

import type { DynamicRecord } from '@/client/utils/typeGuards';

type TaskAcceptedCallback = (taskId: string, metadata: DynamicRecord | undefined) => void;

const listeners: Set<TaskAcceptedCallback> = new Set();

/**
 * Subscribe to backend task acceptance events.
 * @returns Unsubscribe function
 */
export function onBackendTaskAccepted(callback: TaskAcceptedCallback): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Emit a backend task acceptance event.
 * Called internally by executeBackendTaskRequest when a task is accepted.
 */
export function emitBackendTaskAccepted(taskId: string, metadata: DynamicRecord | undefined): void {
  for (const callback of listeners) {
    try {
      callback(taskId, metadata);
    } catch (e) {
      console.warn('[TaskAcceptanceEmitter] Callback error:', e);
    }
  }
}

/**
 * Clear all listeners.
 * Useful for testing or cleanup.
 */
export function clearTaskAcceptedListeners(): void {
  listeners.clear();
}
