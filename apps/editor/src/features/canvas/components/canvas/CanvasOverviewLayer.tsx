'use client';

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useViewport } from '@xyflow/react';
import { labelResizeObserverCallback } from '@/client/utils/resizeObserverDebugLabel';
import {
  drawOverviewMiniCards,
  type OverviewMiniCardNode,
  resolveOverviewMiniCardPalette,
  resolveOverviewMiniCardStyle,
} from '../../utils/overviewMiniCards';

type CanvasOverviewLayerProps = {
  enabled: boolean;
  /** Slim overview nodes used for mini-card rendering. */
  nodes: readonly OverviewMiniCardNode[];
};

export const CanvasOverviewLayer = memo(function CanvasOverviewLayer({
  enabled,
  nodes,
}: CanvasOverviewLayerProps) {
  const { x, y, zoom } = useViewport();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastBuildRef = useRef<{
    at: number;
    width: number;
    height: number;
    zoom: number;
    nodeCount: number;
  } | null>(null);
  const latestArgsRef = useRef({ x, y, zoom, enabled, nodes });

  latestArgsRef.current = { x, y, zoom, enabled, nodes };

  const getBuildThrottleMs = useCallback((count: number) => {
    if (count >= 50000) return 220;
    if (count >= 20000) return 160;
    if (count >= 8000) return 120;
    if (count >= 3000) return 60;
    return 0;
  }, []);

  const resizeCanvasToWrapper = useCallback(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const cssWidth = Math.max(0, Math.floor(rect.width));
    const cssHeight = Math.max(0, Math.floor(rect.height));
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

    const nextWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const nextHeight = Math.max(1, Math.floor(cssHeight * dpr));

    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
    }

    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }, []);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;

      const canvas = canvasRef.current;
      const wrapper = wrapperRef.current;
      if (!canvas || !wrapper) return;

      const { enabled: isEnabled, nodes: latestNodes, x, y, zoom } = latestArgsRef.current;
      if (!isEnabled) {
        lastBuildRef.current = null;
        const rect = wrapper.getBoundingClientRect();
        const screen = { width: rect.width, height: rect.height };
        const palette = resolveOverviewMiniCardPalette();
        const style = resolveOverviewMiniCardStyle(0);
        drawOverviewMiniCards(canvas, {
          nodes: [],
          viewport: { x, y, zoom },
          screen,
          palette,
          style,
        });
        return;
      }

      const rect = wrapper.getBoundingClientRect();
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const width = Math.max(0, Math.floor(rect.width));
      const height = Math.max(0, Math.floor(rect.height));
      const nodeCount = latestNodes.length;
      const throttleMs = getBuildThrottleMs(nodeCount);
      const prev = lastBuildRef.current;
      const shouldForce =
        !prev ||
        prev.width !== width ||
        prev.height !== height ||
        prev.nodeCount !== nodeCount ||
        Math.abs(prev.zoom - zoom) > 0.001;

      if (!shouldForce && throttleMs > 0 && now - prev.at < throttleMs) {
        return;
      }

      lastBuildRef.current = { at: now, width, height, zoom, nodeCount };
      const screen = { width: rect.width, height: rect.height };
      const palette = resolveOverviewMiniCardPalette();
      const style = resolveOverviewMiniCardStyle(nodeCount);
      drawOverviewMiniCards(canvas, {
        nodes: latestNodes,
        viewport: { x, y, zoom },
        screen,
        palette,
        style,
      });
    });
  }, [getBuildThrottleMs]);

  useEffect(() => {
    if (!enabled) {
      scheduleDraw();
      return;
    }
    scheduleDraw();
  }, [enabled, nodes, x, y, zoom, scheduleDraw]);

  useEffect(() => {
    if (!wrapperRef.current || typeof ResizeObserver === 'undefined') return;

    resizeCanvasToWrapper();
    scheduleDraw();

    const observer = new ResizeObserver(
      labelResizeObserverCallback(() => {
        resizeCanvasToWrapper();
        scheduleDraw();
      }, 'CanvasOverviewLayer.wrapperRef'),
    );
    observer.observe(wrapperRef.current);

    return () => {
      observer.disconnect();
    };
  }, [resizeCanvasToWrapper, scheduleDraw]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  const style = useMemo(() => {
    return enabled ? 'opacity-100' : 'opacity-0';
  }, [enabled]);

  return (
    <div
      ref={wrapperRef}
      className={`pointer-events-none absolute inset-0 z-canvas-banner ${style}`}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
});

export default CanvasOverviewLayer;
