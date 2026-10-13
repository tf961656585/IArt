"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { IconPlayerPlay, IconPlayerPause, IconPlus, IconTrash } from "@tabler/icons-react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import type { AudioSegment } from "../../types/audioSegment";
import { generateSegmentId, formatTime, formatDuration } from "../../types/audioSegment";

/** 区域颜色列表 */
const REGION_COLORS = [
  "rgba(79, 70, 229, 0.3)", // indigo
  "rgba(16, 185, 129, 0.3)", // emerald
  "rgba(245, 158, 11, 0.3)", // amber
  "rgba(239, 68, 68, 0.3)", // red
  "rgba(168, 85, 247, 0.3)", // purple
  "rgba(6, 182, 212, 0.3)", // cyan
];
const DEFAULT_REGION_COLOR = "rgba(79, 70, 229, 0.3)";
const getRegionColor = (index: number): string => REGION_COLORS[index % REGION_COLORS.length] ?? DEFAULT_REGION_COLOR;

const WAVEFORM_LOAD_TIMEOUT_MS = 15_000;
const FALLBACK_DURATION_HINT = 1;

interface AudioSegmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audioUrl: string | null;
  duration: number;
  segments: AudioSegment[];
  onSave: (segments: AudioSegment[]) => void;
}

export function AudioSegmentDialog({ open, onOpenChange, audioUrl, duration: initialDuration, segments: initialSegments, onSave }: AudioSegmentDialogProps) {
  const waveformRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const localSegmentsRef = useRef<AudioSegment[]>([]);
  // 使用 state 而非 ref，确保 audio 元素挂载后触发 wavesurfer 初始化
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const setAudioElementRef = useCallback((el: HTMLAudioElement | null) => {
    setAudioElement((prev) => (prev === el ? prev : el));
  }, []);

  const [localSegments, setLocalSegments] = useState<AudioSegment[]>([]);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(initialDuration);
  const [isWaveReady, setIsWaveReady] = useState(false);
  const [waveLoading, setWaveLoading] = useState<number | null>(null);
  const [waveError, setWaveError] = useState<string | null>(null);

  // 分段 ID 到颜色索引的映射
  const segmentColorMap = useMemo(() => {
    const map = new Map<string, string>();
    localSegments.forEach((seg, index) => {
      map.set(seg.id, getRegionColor(index));
    });
    return map;
  }, [localSegments]);

  // 同步初始分段
  useEffect(() => {
    if (open) {
      const nextSegments = initialSegments.map((s) => ({ ...s }));
      localSegmentsRef.current = nextSegments;
      setLocalSegments(nextSegments);
      setSelectedSegmentId((nextSegments[0] !== null && nextSegments[0] !== undefined ? nextSegments[0].id : undefined) ?? null);
      setCurrentTime(0);
      setIsWaveReady(false);
      setWaveLoading(null);
      setWaveError(null);
    }
  }, [initialSegments, open]);

  useEffect(() => {
    localSegmentsRef.current = localSegments;
  }, [localSegments]);

  // 使用原生 audio 元素驱动播放/时长（不依赖波形解码）
  useEffect(() => {
    if (!audioElement) return;

    if (!open) {
      audioElement.pause();
      audioElement.currentTime = 0;
      setIsPlaying(false);
      setCurrentTime(0);
      return;
    }

    if (!audioUrl) return;

    const handleLoadedMetadata = () => {
      const nextDuration = Number.isFinite(audioElement.duration) ? audioElement.duration : initialDuration;
      setDuration(nextDuration || 0);
      setCurrentTime(audioElement.currentTime || 0);
    };
    const handleDurationChange = () => {
      const nextDuration = Number.isFinite(audioElement.duration) ? audioElement.duration : initialDuration;
      setDuration(nextDuration || 0);
    };
    const handleTimeUpdate = () => setCurrentTime(audioElement.currentTime || 0);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    audioElement.addEventListener("loadedmetadata", handleLoadedMetadata);
    audioElement.addEventListener("durationchange", handleDurationChange);
    audioElement.addEventListener("timeupdate", handleTimeUpdate);
    audioElement.addEventListener("play", handlePlay);
    audioElement.addEventListener("pause", handlePause);

    // 触发加载 metadata（对 blob URL 也可靠）
    audioElement.preload = "metadata";
    if (audioElement.src !== audioUrl) {
      audioElement.src = audioUrl;
    }
    audioElement.load();

    return () => {
      audioElement.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audioElement.removeEventListener("durationchange", handleDurationChange);
      audioElement.removeEventListener("timeupdate", handleTimeUpdate);
      audioElement.removeEventListener("play", handlePlay);
      audioElement.removeEventListener("pause", handlePause);
    };
  }, [audioElement, audioUrl, initialDuration, open]);

  // 初始化 wavesurfer
  useEffect(() => {
    if (!open || !waveformRef.current || !audioUrl || !audioElement) return;

    let disposed = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const regions = RegionsPlugin.create();
    regionsRef.current = regions;

    const ws = WaveSurfer.create({
      container: waveformRef.current,
      media: audioElement,
      backend: "MediaElement",
      waveColor: "#6366f1",
      progressColor: "#a5b4fc",
      cursorColor: "#ef4444",
      height: 100,
      normalize: true,
      // 避免部分浏览器不支持过低采样率导致解码失败
      sampleRate: 44100,
      plugins: [regions],
    });

    setIsWaveReady(false);
    setWaveLoading(0);
    setWaveError(null);

    ws.on("loading", (percent) => {
      const next = Number(percent);
      if (!Number.isFinite(next)) return;
      setWaveLoading(Math.max(0, Math.min(100, next)));
    });
    ws.on("error", (err) => {
      if (disposed) return;
      setWaveError((err !== null && err !== undefined ? err.message : undefined) || "波形解析失败");
      setIsWaveReady(false);
      setWaveLoading(null);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    });

    ws.on("ready", () => {
      if (disposed) return;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      const wsDuration = ws.getDuration();
      if (!Number.isFinite(wsDuration) || wsDuration <= 0) {
        setIsWaveReady(false);
        setWaveLoading(null);
        setWaveError("无法获取音频时长，波形不可用，可继续使用下方时间轴分段");
        return;
      }

      setIsWaveReady(true);
      setWaveLoading(null);
      setWaveError(null);

      // 加载现有分段为 regions
      localSegmentsRef.current.forEach((seg, index) => {
        regions.addRegion({
          id: seg.id,
          start: seg.startTime,
          end: seg.endTime,
          color: getRegionColor(index),
          drag: true,
          resize: true,
        });
      });

      // 允许在波形上拖拽创建新分段
      regions.enableDragSelection(
        {
          drag: true,
          resize: true,
          minLength: 0.1,
          color: "rgba(99, 102, 241, 0.2)",
        },
        2,
      );
    });

    // duration 作为提示：避免部分浏览器/资源在 loadedmetadata 上卡住导致一直不触发 ready
    // 注意：有些音频资源无法稳定触发 loadedmetadata（或拿到 0 时长），这里用最小正值兜底，
    // 让 wavesurfer 至少能继续解码并在超时后回退到时间轴分段，避免界面一直卡在“正在解析波形”。
    const durationHint = (Number.isFinite(initialDuration) && initialDuration > 0 ? initialDuration : undefined) ?? FALLBACK_DURATION_HINT;

    timeoutId = setTimeout(() => {
      if (disposed) return;
      setWaveError("波形解析超时，可继续使用下方时间轴分段（可稍后重试）");
      setIsWaveReady(false);
      setWaveLoading(null);
    }, WAVEFORM_LOAD_TIMEOUT_MS);

    void ws.load(audioUrl, undefined, durationHint).catch((err: unknown) => {
      if (disposed) return;
      setWaveError(err instanceof Error ? err.message : "波形解析失败");
      setIsWaveReady(false);
      setWaveLoading(null);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    });

    // 新建区域（按钮添加 / 拖拽创建）时同步到分段列表
    regions.on("region-created", (region: Region) => {
      const alreadyExists = localSegmentsRef.current.some((s) => s.id === region.id);
      if (alreadyExists) return;

      const nextIndex = localSegmentsRef.current.length;
      const color = getRegionColor(nextIndex);
      region.setOptions({ color });

      setLocalSegments((prev) => [
        ...prev,
        {
          id: region.id,
          name: `分段 ${prev.length + 1}`,
          startTime: region.start,
          endTime: region.end,
          sliced: false,
          segmentUrl: undefined,
        },
      ]);
      setSelectedSegmentId(region.id);
    });

    // 监听区域变化
    regions.on("region-updated", (region: Region) => {
      setLocalSegments((prev) => prev.map((seg) => (seg.id === region.id ? { ...seg, startTime: region.start, endTime: region.end, sliced: false } : seg)));
    });

    // 点击区域时选中
    regions.on("region-clicked", (region: Region, e: MouseEvent) => {
      e.stopPropagation();
      setSelectedSegmentId(region.id);
    });

    wavesurferRef.current = ws;

    return () => {
      disposed = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      try {
        ws.destroy();
      } catch {
        // ignore
      }
      wavesurferRef.current = null;
      regionsRef.current = null;
      setIsWaveReady(false);
    };
  }, [open, audioUrl, audioElement, initialDuration]);

  // 添加新分段
  const handleAddSegment = useCallback(() => {
    const regions = regionsRef.current;
    const time = (audioElement !== null && audioElement !== undefined ? audioElement.currentTime : undefined) ?? 0;
    const totalDuration = duration || initialDuration || 0;
    const defaultLength = 5;

    // 波形可用：通过 region 创建（由 region-created 事件同步到列表）
    if (isWaveReady && regions) {
      const nextIndex = localSegmentsRef.current.length;
      const newId = generateSegmentId();
      const colorIndex = nextIndex % REGION_COLORS.length;
      regions.addRegion({
        id: newId,
        start: time,
        end: Math.min(time + defaultLength, totalDuration || time + defaultLength),
        color: getRegionColor(colorIndex),
        drag: true,
        resize: true,
        minLength: 0.1,
      });
      setSelectedSegmentId(newId);
      return;
    }

    // 波形不可用：降级为"时间轴分段"
    const newSegment: AudioSegment = {
      id: generateSegmentId(),
      name: `分段 ${localSegmentsRef.current.length + 1}`,
      startTime: time,
      endTime: Math.min(time + defaultLength, totalDuration || time + defaultLength),
      sliced: false,
      segmentUrl: undefined,
    };
    setLocalSegments((prev) => [...prev, newSegment]);
    setSelectedSegmentId(newSegment.id);
  }, [audioElement, duration, initialDuration, isWaveReady]);

  // 删除分段
  const handleDeleteSegment = useCallback(
    (segmentId: string) => {
      const regions = regionsRef.current;
      if (regions) {
        const allRegions = regions.getRegions();
        const region = allRegions.find((r) => r.id === segmentId);
        if (region !== null && region !== undefined) {
          region.remove();
        }
      }
      setLocalSegments((prev) => prev.filter((s) => s.id !== segmentId));
      if (selectedSegmentId === segmentId) {
        setSelectedSegmentId(null);
      }
    },
    [selectedSegmentId],
  );

  // 更新分段名称
  const handleNameChange = useCallback((segmentId: string, name: string) => {
    setLocalSegments((prev) => prev.map((seg) => (seg.id === segmentId ? { ...seg, name } : seg)));
  }, []);

  // 跳转到分段位置
  const handleSegmentClick = useCallback(
    (segment: AudioSegment) => {
      setSelectedSegmentId(segment.id);
      if (audioElement) {
        audioElement.currentTime = segment.startTime;
      }
    },
    [audioElement],
  );

  // 播放/暂停
  const handlePlayPause = useCallback(() => {
    if (!audioElement) return;
    if (audioElement.paused) {
      void audioElement.play().catch(() => {});
    } else {
      audioElement.pause();
    }
  }, [audioElement]);

  // 保存并关闭
  const handleSave = useCallback(() => {
    onSave(localSegments);
    onOpenChange(false);
  }, [localSegments, onSave, onOpenChange]);

  // 取消
  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const selectedSegment = useMemo(() => {
    if (!selectedSegmentId) return null;
    return localSegments.find((s) => s.id === selectedSegmentId) ?? null;
  }, [localSegments, selectedSegmentId]);

  const handleSelectedRangeChange = useCallback(
    (value: number[]) => {
      if (!selectedSegmentId) return;
      const [start, end] = value;
      if (start === undefined || end === undefined) return;
      setLocalSegments((prev) =>
        prev.map((seg) =>
          seg.id === selectedSegmentId
            ? {
                ...seg,
                startTime: Math.max(0, Math.min(start, end - 0.05)),
                endTime: Math.max(start + 0.05, end),
                sliced: false,
              }
            : seg,
        ),
      );
    },
    [selectedSegmentId],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent form="canvas" fill className="p-0 gap-0">
        <DialogHeader className="shrink-0 px-6 pt-5 pb-3">
          <DialogTitle className="pr-8">音频分段编辑</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-6 py-4">
          {/* 波形显示区 */}
          <div className="shrink-0 space-y-2">
            <div className="relative">
              <div ref={waveformRef} className="w-full rounded border bg-muted/20 min-h-[100px]" />
              {!isWaveReady && (
                <div className="absolute inset-0 flex items-center justify-center rounded border bg-background/60 backdrop-blur-sm">
                  <div className="w-full px-4 py-6 text-center text-sm text-muted-foreground space-y-3">
                    {!audioUrl ? (
                      <div className="space-y-1">
                        <div>还没有可预览的音频</div>
                        <div className="text-xs opacity-80">请先上传音频，或先让上游节点生成结果</div>
                      </div>
                    ) : waveError ? (
                      <div className="space-y-1">
                        <div>波形解析失败，可继续使用下方时间轴分段</div>
                        <div className="text-xs opacity-80">{waveError}</div>
                      </div>
                    ) : (
                      <div>正在解析波形…</div>
                    )}
                    {audioUrl && typeof waveLoading === "number" && !waveError && (
                      <div className="space-y-2">
                        <Progress value={waveLoading} />
                        <div className="text-xs">{Math.round(waveLoading)}%</div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            {(duration ?? 0) > 0 && (
              <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            )}
          </div>

          {/* 播放控制 */}
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" onClick={handlePlayPause} disabled={!audioUrl}>
              {isPlaying ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />}
            </Button>
            <Button size="sm" variant="outline" onClick={handleAddSegment} disabled={!audioUrl}>
              <IconPlus size={14} className="mr-1" />
              从当前位置添加分段
            </Button>
          </div>

          {/* 波形不可用时：时间轴分段编辑 */}
          {!isWaveReady && selectedSegment && (duration ?? 0) > 0 && (
            <div className="shrink-0 space-y-2 rounded border bg-muted/10 p-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>调整分段范围</span>
                <span>
                  {formatTime(selectedSegment.startTime)} - {formatTime(selectedSegment.endTime)}（{formatDuration(selectedSegment.endTime - selectedSegment.startTime)}）
                </span>
              </div>
              <Slider value={[selectedSegment.startTime, selectedSegment.endTime]} min={0} max={duration} step={0.05} onValueChange={handleSelectedRangeChange} />
            </div>
          )}

          {/* 分段列表编辑：唯一内滚容器（数据集区域内滚，外部不滚） */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
            <div className="space-y-2">
              {localSegments.map((seg) => (
                <div
                  key={seg.id}
                  className={cn("flex items-center gap-2 p-2 rounded border cursor-pointer transition-colors", selectedSegmentId === seg.id ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/50")}
                  onClick={() => handleSegmentClick(seg)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleSegmentClick(seg);
                    }
                  }}
                >
                  {/* 颜色指示器 */}
                  <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: segmentColorMap.get(seg.id) }} />
                  {/* 名称输入 */}
                  <Input value={seg.name} onChange={(e) => handleNameChange(seg.id, e.target.value)} className="h-7 flex-1 text-sm" onClick={(e) => e.stopPropagation()} />
                  {/* 时间范围 */}
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatTime(seg.startTime)} - {formatTime(seg.endTime)}
                  </span>
                  {/* 时长 */}
                  <span className="text-xs text-muted-foreground whitespace-nowrap w-12 text-right">({formatDuration(seg.endTime - seg.startTime)})</span>
                  {/* 删除按钮 */}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteSegment(seg.id);
                    }}
                  >
                    <IconTrash size={14} />
                  </Button>
                </div>
              ))}
              {localSegments.length === 0 && <div className="text-center text-sm text-muted-foreground py-8">点击上方按钮添加分段{isWaveReady ? "，或在波形上直接拖拽" : "，并在时间轴上调整范围"}</div>}
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 px-6 pb-5 sm:gap-0">
          <Button variant="outline" onClick={handleCancel}>
            取消
          </Button>
          <Button onClick={handleSave}>保存分段 ({localSegments.length})</Button>
        </DialogFooter>

        {/* 隐藏音频元素：统一驱动时长/播放状态 */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio ref={setAudioElementRef} className="sr-only" />
      </DialogContent>
    </Dialog>
  );
}

export default AudioSegmentDialog;
