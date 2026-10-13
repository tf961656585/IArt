import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { SpriteSheetLayout } from '@iart/contracts/media-processing-contract';
import { computeLayout } from './spriteSheetLayout';
import type { VideoMeta } from '../../types';

const DEFAULT_STEP = 0.1;
export const FINE_STEP = 0.01;

const decimalsFromStep = (step: number): number => {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = step.toString();
  const dotIndex = text.indexOf('.');
  return dotIndex === -1 ? 0 : text.length - dotIndex - 1;
};

export const roundToStep = (value: number, step: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(step) || step <= 0) return value;
  const decimals = decimalsFromStep(step);
  return Number((Math.round(value / step) * step).toFixed(decimals));
};

export const clampRange = (
  start: number,
  end: number,
  step: number,
  max: number | undefined,
): [number, number] => {
  const safeStep = Number.isFinite(step) && step > 0 ? step : DEFAULT_STEP;
  let s = Number.isFinite(start) ? start : 0;
  let e = Number.isFinite(end) ? end : 0;
  s = Math.max(0, s);
  e = Math.max(0, e);
  const upper = Number.isFinite(max) ? Math.max(0, Number(max)) : null;
  if (upper !== null) {
    s = Math.min(s, upper);
    e = Math.min(e, upper);
  }
  if (e < s) {
    const tmp = s;
    s = e;
    e = tmp;
  }
  s = roundToStep(s, safeStep);
  e = roundToStep(e, safeStep);
  if (upper !== null) {
    s = Math.min(s, upper);
    e = Math.min(e, upper);
  }
  if (e - s <= 0) {
    e = roundToStep(s + safeStep, safeStep);
    if (upper !== null && e > upper) {
      e = upper;
      s = roundToStep(Math.max(0, e - safeStep), safeStep);
    }
  }
  return [s, e];
};

type RangeDragState = {
  active: boolean;
  pointerId: number | null;
  startX: number;
  trackWidth: number;
  baseRange: [number, number];
};

export function useVideoSpriteSheetDialogState(params: {
  open: boolean;
  videoUrl: string | null;
  videoMeta: VideoMeta | null;
  fps: number | undefined;
  videoRef: RefObject<HTMLVideoElement | null>;
  rangeTrackRef: RefObject<HTMLDivElement | null>;
}) {
  const { open, videoUrl, videoMeta, fps, videoRef, rangeTrackRef } = params;

  const draftRangeRef = useRef<[number, number]>([0, 3]);
  const activeThumbRef = useRef<'start' | 'end' | null>(null);
  const seekRafRef = useRef<number | null>(null);
  const pendingSeekTimeRef = useRef<number | null>(null);
  const lastPreviewTimeRef = useRef<number | null>(null);

  const [duration, setDuration] = useState<number>(0);
  const [draftRange, setDraftRange] = useState<[number, number]>([0, 3]);
  const [isFineAdjust, setIsFineAdjust] = useState(false);
  const [isDraggingRange, setIsDraggingRange] = useState(false);
  const [fpsMultiplier, setFpsMultiplier] = useState(1);
  const [stepSize, setStepSize] = useState(0.25);

  const rangeDragStateRef = useRef<RangeDragState>({
    active: false,
    pointerId: null,
    startX: 0,
    trackWidth: 0,
    baseRange: [0, 0],
  });

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setDraftRange([0, 3]);
      draftRangeRef.current = [0, 3];
      setDuration(0);
      setFpsMultiplier(1);
      setStepSize(0.25);
      setIsFineAdjust(false);
      setIsDraggingRange(false);
      activeThumbRef.current = null;
      lastPreviewTimeRef.current = null;
      rangeDragStateRef.current = {
        active: false,
        pointerId: null,
        startX: 0,
        trackWidth: 0,
        baseRange: [0, 0],
      };
      return;
    }
  }, [open]);

  // Keep draftRangeRef in sync
  useEffect(() => {
    draftRangeRef.current = draftRange;
  }, [draftRange]);

  // Shift key fine adjust
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setIsFineAdjust(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setIsFineAdjust(false);
      }
    };
    const handleBlur = () => {
      setIsFineAdjust(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [open]);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (seekRafRef.current !== null) {
        cancelAnimationFrame(seekRafRef.current);
        seekRafRef.current = null;
      }
    };
  }, []);

  // Reset duration when video source changes
  useEffect(() => {
    setDuration(0);
  }, [videoUrl]);

  const seekPreviewFrame = useCallback((timeSec: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(timeSec)) return;
    try {
      const nextTime = Math.max(0, timeSec);
      const seekableVideo = video as HTMLVideoElement & {
        fastSeek: (time: number) => void | undefined;
      };
      if (typeof seekableVideo.fastSeek === 'function') {
        seekableVideo.fastSeek(nextTime);
      } else {
        video.currentTime = nextTime;
      }
      video.pause();
    } catch {
      // ignore
    }
  }, [videoRef]);

  const requestSeekPreviewFrame = useCallback(
    (timeSec: number) => {
      pendingSeekTimeRef.current = timeSec;
      lastPreviewTimeRef.current = timeSec;
      if (seekRafRef.current !== null) return;
      seekRafRef.current = requestAnimationFrame(() => {
        seekRafRef.current = null;
        const next = pendingSeekTimeRef.current;
        if (typeof next !== 'number' || !Number.isFinite(next)) return;
        seekPreviewFrame(next);
      });
    },
    [seekPreviewFrame],
  );

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const d = Number.isFinite(video.duration) ? video.duration : 0;
    setDuration(d);

    if (d > 0) {
      const initialEnd = Math.min(3, d);
      const next = clampRange(0, initialEnd, FINE_STEP, d);
      draftRangeRef.current = next;
      setDraftRange(next);
    }

    const previewTime = lastPreviewTimeRef.current ?? draftRangeRef.current[0];
    if (Number.isFinite(previewTime)) {
      requestSeekPreviewFrame(previewTime);
    }
  }, [requestSeekPreviewFrame, videoRef]);

  const handleSliderChange = useCallback(
    (values: number[]) => {
      const next = clampRange(
        values[0] ?? 0,
        values[1] ?? 0,
        isFineAdjust ? FINE_STEP : DEFAULT_STEP,
        duration > 0 ? duration : undefined,
      );

      const prev = draftRangeRef.current;
      const startChanged = next[0] !== prev[0];
      const endChanged = next[1] !== prev[1];
      const seekTime =
        activeThumbRef.current === 'end'
          ? next[1]
          : activeThumbRef.current === 'start'
            ? next[0]
            : endChanged && !startChanged
              ? next[1]
              : next[0];

      draftRangeRef.current = next;
      setDraftRange(next);
      requestSeekPreviewFrame(seekTime);
    },
    [duration, isFineAdjust, requestSeekPreviewFrame],
  );

  const handleSliderCommit = useCallback(
    (_values: number[]) => {
      const current = draftRangeRef.current;
      const next = clampRange(
        current[0],
        current[1],
        FINE_STEP,
        duration > 0 ? duration : undefined,
      );
      draftRangeRef.current = next;
      setDraftRange(next);
      activeThumbRef.current = null;
    },
    [duration],
  );

  const handleSliderPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLSpanElement>) => {
      activeThumbRef.current = null;
      const target = event.target as HTMLElement | null;
      const thumb = target
        ? (target.closest('[role="slider"]') as HTMLElement | null)
        : null;
      if (thumb) {
        const label = (thumb.getAttribute('aria-label') ?? '').toLowerCase();
        if (label.includes('maximum')) activeThumbRef.current = 'end';
        else if (label.includes('minimum')) activeThumbRef.current = 'start';
      }
      try {
        if (videoRef.current !== null && videoRef.current !== undefined) {
          videoRef.current.pause();
        }
      } catch {
        // ignore
      }
    },
    [videoRef],
  );

  const handleStartChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const raw = Number(event.target.value);
      if (!Number.isFinite(raw)) return;
      setDraftRange((prev) => {
        const next = clampRange(
          raw,
          prev[1],
          isFineAdjust ? FINE_STEP : DEFAULT_STEP,
          duration > 0 ? duration : undefined,
        );
        draftRangeRef.current = next;
        return next;
      });
      requestSeekPreviewFrame(raw);
    },
    [duration, isFineAdjust, requestSeekPreviewFrame],
  );

  const handleEndChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const raw = Number(event.target.value);
      if (!Number.isFinite(raw)) return;
      setDraftRange((prev) => {
        const next = clampRange(
          prev[0],
          raw,
          isFineAdjust ? FINE_STEP : DEFAULT_STEP,
          duration > 0 ? duration : undefined,
        );
        draftRangeRef.current = next;
        return next;
      });
      requestSeekPreviewFrame(raw);
    },
    [duration, isFineAdjust, requestSeekPreviewFrame],
  );

  const handleRangeBlur = useCallback(() => {
    const current = draftRangeRef.current;
    const next = clampRange(
      current[0],
      current[1],
      FINE_STEP,
      duration > 0 ? duration : undefined,
    );
    draftRangeRef.current = next;
    setDraftRange(next);
  }, [duration]);

  const handleRangePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const track = rangeTrackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || rect.width <= 0) return;

      rangeDragStateRef.current = {
        active: true,
        pointerId: event.pointerId,
        startX: event.clientX,
        trackWidth: rect.width,
        baseRange: draftRangeRef.current,
      };
      setIsDraggingRange(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [rangeTrackRef],
  );

  const commitRangeDrag = useCallback(
    (pointerId: number) => {
      const state = rangeDragStateRef.current;
      if (!state.active || state.pointerId !== pointerId) return;
      rangeDragStateRef.current.active = false;
      setIsDraggingRange(false);

      const current = draftRangeRef.current;
      const next = clampRange(
        current[0],
        current[1],
        FINE_STEP,
        duration > 0 ? duration : undefined,
      );
      draftRangeRef.current = next;
      setDraftRange(next);
    },
    [duration],
  );

  const handleRangePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = rangeDragStateRef.current;
      if (!state.active || state.pointerId !== event.pointerId) return;

      const max = duration > 0 ? duration : Math.max(state.baseRange[1], 1);
      const length = state.baseRange[1] - state.baseRange[0];
      if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(length) || length <= 0) {
        return;
      }

      const dx = event.clientX - state.startX;
      const rawDelta = (dx / state.trackWidth) * max;
      const step = isFineAdjust ? FINE_STEP : DEFAULT_STEP;
      const delta = roundToStep(rawDelta, step);

      const upperStart = Math.max(0, max - length);
      let nextStart = Math.min(
        Math.max(0, state.baseRange[0] + delta),
        upperStart,
      );
      nextStart = roundToStep(nextStart, step);
      nextStart = Math.min(Math.max(0, nextStart), upperStart);

      let nextEnd = nextStart + length;
      if (nextEnd > max) {
        nextEnd = max;
        nextStart = Math.max(0, nextEnd - length);
      }

      const next: [number, number] = [nextStart, nextEnd];
      draftRangeRef.current = next;
      setDraftRange(next);
      requestSeekPreviewFrame(next[0]);
    },
    [duration, isFineAdjust, requestSeekPreviewFrame],
  );

  const handleRangePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      commitRangeDrag(event.pointerId);
    },
    [commitRangeDrag],
  );

  const handleRangePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      commitRangeDrag(event.pointerId);
    },
    [commitRangeDrag],
  );

  const handleMultiplierChange = useCallback(
    (values: number[]) => {
      const raw = values[0] ?? 1;
      const snapped = roundToStep(raw, stepSize);
      setFpsMultiplier(Math.min(1, Math.max(0, snapped)));
    },
    [stepSize],
  );

  const handleStepSizeChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const raw = Number(event.target.value);
      if (!Number.isFinite(raw)) return;
      const clamped = Math.min(1, Math.max(0.01, raw));
      setStepSize(clamped);
      setFpsMultiplier((prev) => roundToStep(prev, clamped));
    },
    [],
  );

  const layout: SpriteSheetLayout | null = useMemo(() => {
    const videoWidth =
      videoMeta !== null && videoMeta !== undefined ? videoMeta.width : undefined;
    const videoHeight =
      videoMeta !== null && videoMeta !== undefined ? videoMeta.height : undefined;
    if (videoWidth === undefined || videoHeight === undefined) {
      return computeLayout({
        fps,
        multiplier: fpsMultiplier,
        startTime: draftRange[0],
        endTime: draftRange[1],
        videoWidth: 1920,
        videoHeight: 1080,
      });
    }
    return computeLayout({
      fps,
      multiplier: fpsMultiplier,
      startTime: draftRange[0],
      endTime: draftRange[1],
      videoWidth,
      videoHeight,
    });
  }, [draftRange, fps, fpsMultiplier, videoMeta]);

  const sliderMax = useMemo(() => {
    const base = duration > 0 ? duration : Math.max(draftRange[1], 1);
    return Math.max(1, base);
  }, [draftRange, duration]);

  const rangeLeftPercent = useMemo(() => {
    if (!Number.isFinite(sliderMax) || sliderMax <= 0) return 0;
    return Math.min(100, Math.max(0, (draftRange[0] / sliderMax) * 100));
  }, [draftRange, sliderMax]);

  const rangeWidthPercent = useMemo(() => {
    if (!Number.isFinite(sliderMax) || sliderMax <= 0) return 0;
    return Math.min(
      100,
      Math.max(0, ((draftRange[1] - draftRange[0]) / sliderMax) * 100),
    );
  }, [draftRange, sliderMax]);

  return {
    // State
    draftRange,
    duration,
    fpsMultiplier,
    stepSize,
    isDraggingRange,
    layout,
    sliderMax,
    rangeLeftPercent,
    rangeWidthPercent,
    // Handlers
    handleLoadedMetadata,
    handleSliderChange,
    handleSliderCommit,
    handleSliderPointerDownCapture,
    handleStartChange,
    handleEndChange,
    handleRangeBlur,
    handleRangePointerDown,
    handleRangePointerMove,
    handleRangePointerUp,
    handleRangePointerCancel,
    handleMultiplierChange,
    handleStepSizeChange,
    setFpsMultiplier,
    setStepSize,
  };
}
