'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type StartupReadySignal = {
  graphId: string;
  sessionToken: string;
};

/**
 * 把启动放行收口在当前 editor 会话本地，避免任何全局 store 直写绕过真实链路。
 */
export function useCanvasStartupGate(
  nodeGraphId: string | null,
  startupSessionToken: string | null
): {
  startupReady: boolean;
  reportStartupInteractiveReady: (graphId: string | null, sessionToken: string | null) => boolean;
  resetStartupInteractiveReady: () => void;
} {
  const [readySignal, setReadySignal] = useState<StartupReadySignal | null>(null);
  const currentSessionRef = useRef({
    nodeGraphId,
    startupSessionToken,
  });

  useEffect(() => {
    currentSessionRef.current = {
      nodeGraphId,
      startupSessionToken,
    };
  }, [nodeGraphId, startupSessionToken]);

  useEffect(() => {
    setReadySignal((currentSignal) => {
      if (!nodeGraphId || !startupSessionToken) {
        return currentSignal === null ? currentSignal : null;
      }
      if (
        (currentSignal !== null && currentSignal !== undefined ? currentSignal.graphId : undefined) === nodeGraphId &&
        currentSignal !== null &&
        currentSignal.sessionToken === startupSessionToken
      ) {
        return currentSignal;
      }
      return null;
    });
  }, [nodeGraphId, startupSessionToken]);

  const reportStartupInteractiveReady = useCallback((graphId: string | null, sessionToken: string | null) => {
    const currentSession = currentSessionRef.current;
    if (!graphId || !sessionToken) {
      console.info('[canvas:prep] startup-ready rejected', {
        reason: 'missing-graph-or-session-token',
        graphId,
        hasSessionToken: Boolean(sessionToken),
      });
      return false;
    }
    if (graphId !== currentSession.nodeGraphId) {
      console.info('[canvas:prep] startup-ready rejected', {
        reason: 'graph-id-mismatch',
        graphId,
        currentNodeGraphId: currentSession.nodeGraphId,
      });
      return false;
    }
    if (sessionToken !== currentSession.startupSessionToken) {
      console.info('[canvas:prep] startup-ready rejected', {
        reason: 'session-token-mismatch',
        hasSessionToken: true,
        hasCurrentSessionToken: Boolean(currentSession.startupSessionToken),
      });
      return false;
    }
    console.info('[canvas:prep] startup-ready accepted', {
      graphId,
      hasSessionToken: true,
    });
    setReadySignal({ graphId, sessionToken });
    return true;
  }, []);

  const resetStartupInteractiveReady = useCallback(() => {
    setReadySignal(null);
  }, []);

  const startupReady = Boolean(
    nodeGraphId &&
      startupSessionToken &&
      (readySignal !== null && readySignal !== undefined ? readySignal.graphId : undefined) === nodeGraphId &&
      readySignal !== null &&
      readySignal.sessionToken === startupSessionToken
  );

  return {
    startupReady,
    reportStartupInteractiveReady,
    resetStartupInteractiveReady,
  };
}

export default useCanvasStartupGate;
