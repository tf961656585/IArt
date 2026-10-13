'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type ProgressOverlayStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled';

export type ProgressOverlayState<TProgressEvent> = {
  status: ProgressOverlayStatus;
  visible: boolean;
  hidden: boolean;
  progressEvent: TProgressEvent | null;
  elapsedMs: number;
  errorMessage: string | null;
};

export type ProgressOverlayTaskRunner<TRequest, TProgressEvent, TResult> = (ctx: {
  request: TRequest;
  signal: AbortSignal;
  onProgress: (event: TProgressEvent) => void;
}) => Promise<TResult>;

export type ProgressOverlayTaskDescriptor<TRequest, TProgressEvent, TResult> = {
  run: ProgressOverlayTaskRunner<TRequest, TProgressEvent, TResult>;
  showDelayMs: number | undefined;
  autoDismissMs: number | undefined;
  elapsedTickMs: number | undefined;

  classifyError: (
    error: unknown
  ) => { status: Extract<ProgressOverlayStatus, 'cancelled' | 'error'>; message: string | undefined } | undefined;
  onAlreadyRunning: () => void | undefined;
  onSuccess: (result: TResult) => void | undefined;
  onCancelled: () => void | undefined;
  onError: (error: unknown, message: string) => void | undefined;
};

const DEFAULT_SHOW_DELAY_MS = 500;
const DEFAULT_AUTO_DISMISS_MS = 1500;
const DEFAULT_ELAPSED_TICK_MS = 250;

export function useProgressOverlayTask<TRequest, TProgressEvent, TResult>(
  descriptor: ProgressOverlayTaskDescriptor<TRequest, TProgressEvent, TResult>
) {
  const showDelayMs = descriptor.showDelayMs ?? DEFAULT_SHOW_DELAY_MS;
  const autoDismissMs = descriptor.autoDismissMs ?? DEFAULT_AUTO_DISMISS_MS;
  const elapsedTickMs = descriptor.elapsedTickMs ?? DEFAULT_ELAPSED_TICK_MS;

  const [status, setStatus] = useState<ProgressOverlayStatus>('idle');
  const [visible, setVisible] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [progressEvent, setProgressEvent] = useState<TProgressEvent | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const statusRef = useRef(status);
  const hiddenRef = useRef(hidden);
  const visibleRef = useRef(visible);
  const runIdRef = useRef(0);
  const startTimeRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    hiddenRef.current = hidden;
  }, [hidden]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  const clearElapsedTimer = useCallback(() => {
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  const stopTimers = useCallback(() => {
    clearShowTimer();
    clearDismissTimer();
    clearElapsedTimer();
  }, [clearDismissTimer, clearElapsedTimer, clearShowTimer]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      stopTimers();
    };
  }, [stopTimers]);

  const startElapsedTicker = useCallback(() => {
    clearElapsedTimer();
    elapsedTimerRef.current = window.setInterval(() => {
      if (!mountedRef.current) return;
      if (!startTimeRef.current) return;
      setElapsedMs(Date.now() - startTimeRef.current);
    }, elapsedTickMs);
  }, [clearElapsedTimer, elapsedTickMs]);

  const resetToIdle = useCallback(() => {
    setVisible(false);
    setStatus('idle');
    setHidden(false);
    setProgressEvent(null);
    setErrorMessage(null);
    setElapsedMs(0);
  }, []);

  const finalizeRun = useCallback(
    (runId: number, nextStatus: Exclude<ProgressOverlayStatus, 'idle'>, message: string | undefined) => {
      if (!mountedRef.current || runIdRef.current !== runId) return;

      clearShowTimer();
      clearElapsedTimer();
      clearDismissTimer();

      setStatus(nextStatus);
      setErrorMessage(message ?? null);
      if (startTimeRef.current) {
        setElapsedMs(Date.now() - startTimeRef.current);
      }

      const shouldShowTerminal = visibleRef.current && !hiddenRef.current;
      if (shouldShowTerminal) {
        dismissTimerRef.current = window.setTimeout(() => {
          if (!mountedRef.current || runIdRef.current !== runId) return;
          resetToIdle();
        }, autoDismissMs);
        return;
      }

      resetToIdle();
    },
    [
      autoDismissMs,
      clearDismissTimer,
      clearElapsedTimer,
      clearShowTimer,
      resetToIdle,
    ]
  );

  const runTask = useCallback(
    async (request: TRequest, runId: number, signal: AbortSignal) => {
      try {
        const result = await descriptor.run({
          request,
          signal,
          onProgress: (event) => {
            if (!mountedRef.current || runIdRef.current !== runId) return;
            setProgressEvent(event);
          },
        });
        if (!mountedRef.current || runIdRef.current !== runId) return;
        if (descriptor.onSuccess) {
          descriptor.onSuccess(result);
        }
        finalizeRun(runId, 'success', undefined);
      } catch (error) {
        if (!mountedRef.current || runIdRef.current !== runId) return;
        const classified = descriptor.classifyError
          ? descriptor.classifyError(error)
          : undefined;
        if ((classified !== null && classified !== undefined ? classified.status : undefined) === 'cancelled') {
          if (descriptor.onCancelled) {
            descriptor.onCancelled();
          }
          finalizeRun(runId, 'cancelled', undefined);
          return;
        }

        const message =
          (classified !== null && classified !== undefined ? classified.message : undefined) ??
          (error instanceof Error ? error.message : '任务失败');

        if (descriptor.onError) {
          descriptor.onError(error, message);
        }
        finalizeRun(runId, 'error', message);
      } finally {
        if (runIdRef.current === runId) {
          abortControllerRef.current = null;
        }
      }
    },
    [descriptor, finalizeRun]
  );

  const start = useCallback(
    (request: TRequest) => {
      if (statusRef.current === 'running') {
        if (descriptor.onAlreadyRunning) {
          descriptor.onAlreadyRunning();
        }
        setHidden(false);
        clearShowTimer();
        setVisible(true);
        return;
      }

      const runId = runIdRef.current + 1;
      runIdRef.current = runId;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      startTimeRef.current = Date.now();

      setStatus('running');
      setHidden(false);
      setVisible(false);
      setProgressEvent(null);
      setErrorMessage(null);
      setElapsedMs(0);

      stopTimers();
      startElapsedTicker();

      showTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current || runIdRef.current !== runId) return;
        if (statusRef.current !== 'running' || hiddenRef.current) return;
        setVisible(true);
      }, showDelayMs);

      void runTask(request, runId, controller.signal);
    },
    [
      clearShowTimer,
      descriptor,
      runTask,
      showDelayMs,
      startElapsedTicker,
      stopTimers,
    ]
  );

  const hide = useCallback(() => {
    setHidden(true);
    setVisible(false);
    clearShowTimer();
  }, [clearShowTimer]);

  const cancel = useCallback(() => {
    const controller = abortControllerRef.current;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
  }, []);

  const state = useMemo<ProgressOverlayState<TProgressEvent>>(
    () => ({
      status,
      visible,
      hidden,
      progressEvent,
      elapsedMs,
      errorMessage,
    }),
    [elapsedMs, errorMessage, hidden, progressEvent, status, visible]
  );

  return {
    state,
    start,
    hide,
    cancel,
  };
}
