import { useCallback, useRef, useState } from 'react';
import { cloneJsonValue } from '@iart/contracts';

type CloneFn<T> = (value: T) => T;

const defaultClone = <T,>(value: T): T => {
   
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return cloneJsonValue(value);
};

export const useUndoRedoStack = <T,>(options: { limit: number | undefined; clone: CloneFn<T> | undefined } | undefined) => {
  const limit = Math.max(1, Math.floor((options !== null && options !== undefined ? options.limit : undefined) ?? 50));
  const clone = ((options !== null && options !== undefined ? options.clone : undefined) ?? defaultClone) as CloneFn<T>;

  const pastRef = useRef<T[]>([]);
  const futureRef = useRef<T[]>([]);

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const syncFlags = useCallback(() => {
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(futureRef.current.length > 0);
  }, []);

  const reset = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    syncFlags();
  }, [syncFlags]);

  const capture = useCallback(
    (snapshot: T) => {
      pastRef.current.push(clone(snapshot));
      if (pastRef.current.length > limit) {
        pastRef.current.splice(0, pastRef.current.length - limit);
      }
      futureRef.current = [];
      syncFlags();
    },
    [clone, limit, syncFlags]
  );

  const undo = useCallback(
    (current: T): T | null => {
      const prev = pastRef.current.pop();
      if (!prev) {
        syncFlags();
        return null;
      }
      futureRef.current.push(clone(current));
      syncFlags();
      return prev;
    },
    [clone, syncFlags]
  );

  const redo = useCallback(
    (current: T): T | null => {
      const next = futureRef.current.pop();
      if (!next) {
        syncFlags();
        return null;
      }
      pastRef.current.push(clone(current));
      if (pastRef.current.length > limit) {
        pastRef.current.splice(0, pastRef.current.length - limit);
      }
      syncFlags();
      return next;
    },
    [clone, limit, syncFlags]
  );

  const clearFuture = useCallback(() => {
    if (futureRef.current.length === 0) return;
    futureRef.current = [];
    syncFlags();
  }, [syncFlags]);

  return {
    canUndo,
    canRedo,
    capture,
    undo,
    redo,
    reset,
    clearFuture,
  };
};
