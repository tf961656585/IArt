'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ProjectMediaAssets } from '@iart/contracts';
import type { NodeGraph } from '../types';
import { exportNodeGraphToBundleFile } from './exportBundle';
import { isAbortError, type BundleExportProgressEvent } from './bundleTypes';

const SHOW_DELAY_MS = 500;
const AUTO_DISMISS_MS = 1500;
const ELAPSED_TICK_MS = 250;

type ExportStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled';

export type BundleExportRequest = {
  snippet: NodeGraph;
  fileBaseName: string;
  mediaAssets: ProjectMediaAssets | undefined;
};

export type BundleExportProgressState = {
  status: ExportStatus;
  visible: boolean;
  hidden: boolean;
  progressEvent: BundleExportProgressEvent | null;
  elapsedMs: number;
  errorMessage: string | null;
};

export function useBundleExportWithProgress() {
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [visible, setVisible] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [progressEvent, setProgressEvent] = useState<BundleExportProgressEvent | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const statusRef = useRef(status);
  const hiddenRef = useRef(hidden);
  const visibleRef = useRef(visible);
  const runIdRef = useRef(0);
  const startTimeRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

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
  }, [clearShowTimer, clearDismissTimer, clearElapsedTimer]);

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
    }, ELAPSED_TICK_MS);
  }, [clearElapsedTimer]);

  const finalizeRun = useCallback(
    (runId: number, nextStatus: ExportStatus, message: string | undefined) => {
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
          setVisible(false);
          setStatus('idle');
          setProgressEvent(null);
          setErrorMessage(null);
        }, AUTO_DISMISS_MS);
        return;
      }

      setVisible(false);
      setStatus('idle');
      setProgressEvent(null);
      setErrorMessage(null);
    },
    [clearShowTimer, clearElapsedTimer, clearDismissTimer]
  );

  const runExport = useCallback(
    async (request: BundleExportRequest, runId: number, signal: AbortSignal) => {
      try {
        await exportNodeGraphToBundleFile({
          nodeGraph: request.snippet,
          mediaAssets: request.mediaAssets ?? {},
        }, 'dev', {
          compressionLevel: undefined,
          customFileName: request.fileBaseName,
          enableCompression: undefined,
          onProgress: (event) => {
            if (!mountedRef.current || runIdRef.current !== runId) return;
            setProgressEvent(event);
          },
          signal,
        });
        if (!mountedRef.current || runIdRef.current !== runId) return;
        toast.success('已导出 .iarts');
        finalizeRun(runId, 'success', undefined);
      } catch (error) {
        if (!mountedRef.current || runIdRef.current !== runId) return;
        if (isAbortError(error)) {
          finalizeRun(runId, 'cancelled', undefined);
          return;
        }
        const message = error instanceof Error ? error.message : '导出失败';
        toast.error(message);
        finalizeRun(runId, 'error', message);
      } finally {
        if (runIdRef.current === runId) {
          abortControllerRef.current = null;
        }
      }
    },
    [finalizeRun]
  );

  const startExport = useCallback(
    (request: BundleExportRequest) => {
      if (statusRef.current === 'running') {
        toast.info('已有导出任务进行中');
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
      }, SHOW_DELAY_MS);

      void runExport(request, runId, controller.signal);
    },
    [clearShowTimer, runExport, startElapsedTicker, stopTimers]
  );

  const hideOverlay = useCallback(() => {
    setHidden(true);
    setVisible(false);
    clearShowTimer();
  }, [clearShowTimer]);

  const cancelExport = useCallback(() => {
    const controller = abortControllerRef.current;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
  }, []);

  const state = useMemo<BundleExportProgressState>(
    () => ({
      status,
      visible,
      hidden,
      progressEvent,
      elapsedMs,
      errorMessage,
    }),
    [status, visible, hidden, progressEvent, elapsedMs, errorMessage]
  );

  return {
    state,
    startExport,
    hideOverlay,
    cancelExport,
  };
}
