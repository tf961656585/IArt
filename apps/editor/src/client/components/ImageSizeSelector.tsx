import React, { useEffect, useMemo, useState } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ConstrainedImageSizeSelector,
  type ImageSizeSelectorConstrainedAspectPreset,
  type ImageSizeSelectorConstrainedConstraints,
  type ImageSizeSelectorConstrainedSizeLevel,
  type ImageSizeSelectorConstrainedPresetOption,
} from './imageSizeConstrainedResolution';

export type ImageSizeSelectorOption = {
  label: string;
  value: number;
};

export type ImageSizeSelectorAspectOption = {
  id: string | undefined;
  label: string;
  value: string | undefined;
  ratio: number | null | undefined;
  description: string | undefined;
  resolution: { width: number; height: number } | undefined;
};

type ImageSizeSelectorProps = {
  value: string | undefined;
  label: string | undefined;
  onChange: (next: string) => void;
  disabled: boolean | undefined;
  mode: 'constrainedResolution' | undefined;
  options: ImageSizeSelectorOption[] | undefined;
  aspectValue: string | undefined;
  onAspectValueChange: (next: string | undefined, nextResolution: string | undefined) => void | undefined;
  aspectOptions: ImageSizeSelectorAspectOption[] | undefined;
  allowAuto: boolean | undefined;
  sizeLevels: ImageSizeSelectorConstrainedSizeLevel[] | undefined;
  aspectPresets: ImageSizeSelectorConstrainedAspectPreset[] | undefined;
  presetOptions: ImageSizeSelectorConstrainedPresetOption[] | undefined;
  constraints: ImageSizeSelectorConstrainedConstraints | undefined;
  /** 渲染变体: default=完整垂直布局, compact=单行摘要显示 */
  variant: "default" | "compact" | undefined;
};

const DEFAULT_OPTIONS: ImageSizeSelectorOption[] = [
  { label: '1K', value: 1024 },
  { label: '2K', value: 2048 },
  { label: '4K', value: 4096 },
];

type AspectPreset = {
  id: string;
  label: string;
  ratio: number | undefined;
  value: string | undefined;
  description: string | undefined;
  resolution: { width: number; height: number } | undefined;
};

const DEFAULT_ASPECT_RATIO_PRESETS: AspectPreset[] = [
  { id: 'portrait-9-195', label: '9:19.5', ratio: 9 / 19.5, value: undefined, description: undefined, resolution: undefined },
  { id: 'portrait-9-16', label: '9:16', ratio: 9 / 16, value: undefined, description: undefined, resolution: undefined },
  { id: 'portrait-2-3', label: '2:3', ratio: 2 / 3, value: undefined, description: undefined, resolution: undefined },
  { id: 'portrait-3-4', label: '3:4', ratio: 3 / 4, value: undefined, description: undefined, resolution: undefined },
  { id: 'square', label: '1:1', ratio: 1, value: undefined, description: undefined, resolution: undefined },
  { id: 'landscape-4-3', label: '4:3', ratio: 4 / 3, value: undefined, description: undefined, resolution: undefined },
  { id: 'landscape-3-2', label: '3:2', ratio: 3 / 2, value: undefined, description: undefined, resolution: undefined },
  { id: 'landscape-16-9', label: '16:9', ratio: 16 / 9, value: undefined, description: undefined, resolution: undefined },
  { id: 'landscape-195-9', label: '19.5:9', ratio: 19.5 / 9, value: undefined, description: undefined, resolution: undefined },
];

const DIMENSION_MULTIPLE = 64;
const MIN_DIMENSION = 64;

const roundDimension = (value: number) => {
  const rounded = Math.round(Math.max(MIN_DIMENSION, value) / DIMENSION_MULTIPLE) * DIMENSION_MULTIPLE;
  return Math.max(MIN_DIMENSION, rounded);
};

const formatResolution = (width: number, height: number) => `${width}x${height}`;

const parseResolution = (raw: string | undefined) => {
  if (!raw) return { width: 2048, height: 2048 };
  const match = raw.match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!match) return { width: 2048, height: 2048 };
  const [, rawWidth, rawHeight] = match;
  const width = Number.parseInt(rawWidth ?? '', 10);
  const height = Number.parseInt(rawHeight ?? '', 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 2048, height: 2048 };
  }
  return { width, height };
};

const pickNearestOption = (options: ImageSizeSelectorOption[], width: number, height: number) => {
  if (options.length === 0) {
    return { label: '2K', value: 2048 };
  }
  const longest = Math.max(width, height);
  let candidate = options[0] ?? { label: '2K', value: 2048 };
  let minDiff = Math.abs(candidate.value - longest);
  for (let index = 1; index < options.length; index += 1) {
    const option = options[index];
    if (!option) continue;
    const diff = Math.abs(option.value - longest);
    if (diff < minDiff) {
      candidate = option;
      minDiff = diff;
    }
  }
  return candidate;
};

/**
 * 根据目标尺寸等级和宽高比计算分辨率
 * @param base - 参考像素边长（如 2048 代表 2K，4096 代表 4K）
 * @param ratio - 宽高比 (width / height)
 * @returns 计算后的宽高，总像素数约等于 base²
 *
 * 计算原理：
 * - 目标总像素 = base²
 * - 已知 width/height = ratio，width × height = totalPixels
 * - 解得 width = √(totalPixels × ratio)，height = √(totalPixels / ratio)
 */
const computeResolution = (base: number, ratio: number) => {
  const totalPixels = base * base;
  const normalizedRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;

  // width = √(totalPixels × ratio)
  // height = √(totalPixels / ratio)
  const width = roundDimension(Math.sqrt(totalPixels * normalizedRatio));
  const height = roundDimension(Math.sqrt(totalPixels / normalizedRatio));

  return { width, height };
};

const gcd = (a: number, b: number): number => {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const temp = y;
    y = x % y;
    x = temp;
  }
  return x || 1;
};

const formatAspectRatio = (width: number, height: number) => {
  const divisor = gcd(width, height);
  const w = Math.round(width / divisor);
  const h = Math.round(height / divisor);
  return `${w}:${h}`;
};

const orientationKey = (width: number, height: number) => {
  const ratio = width / height;
  if (ratio > 1.05) return 'landscape';
  if (ratio < 0.95) return 'portrait';
  return 'square';
};

export const ImageSizeSelector: React.FC<ImageSizeSelectorProps> = ({
  value,
  label,
  onChange,
  disabled,
  mode,
  options,
  aspectValue,
  onAspectValueChange,
  aspectOptions,
  allowAuto,
  sizeLevels,
  aspectPresets: constrainedAspectPresets,
  presetOptions,
  constraints,
  variant = "default",
}) => {
  const isConstrainedMode = mode === 'constrainedResolution';
  const resolvedOptions =
    options !== null && options !== undefined && options.length > 0 ? options : DEFAULT_OPTIONS;
  const [internalAspectKey, setInternalAspectKey] = useState<string | undefined>(undefined);
  const [popoverOpen, setPopoverOpen] = useState(false);
  useEffect(() => {
    if (typeof aspectValue === 'string' && aspectValue.length > 0) {
      setInternalAspectKey(aspectValue);
    }
  }, [aspectValue]);
  const aspectPresets = useMemo(() => {
    if (!aspectOptions || aspectOptions.length === 0) {
      return DEFAULT_ASPECT_RATIO_PRESETS;
    }
    const presets = aspectOptions.map((option, index) => {
      const id = option.id && option.id.length > 0 ? option.id : `aspect-${index}`;
      const ratioRaw = option.ratio;
      const ratio = typeof ratioRaw === 'number' && Number.isFinite(ratioRaw) && ratioRaw > 0 ? ratioRaw : undefined;
      const resolutionRaw = (option as { resolution: unknown | undefined }).resolution;
      const resolution =
        resolutionRaw && typeof resolutionRaw === 'object' && resolutionRaw !== null
          ? (() => {
              const width = (resolutionRaw as { width: unknown | undefined }).width;
              const height = (resolutionRaw as { height: unknown | undefined }).height;
              if (
                typeof width === 'number' &&
                Number.isFinite(width) &&
                width > 0 &&
                typeof height === 'number' &&
                Number.isFinite(height) &&
                height > 0
              ) {
                return { width, height };
              }
              return undefined;
            })()
          : undefined;
      return {
        id,
        label: option.label,
        ratio,
        value: option.value ?? option.label,
        description: option.description,
        resolution,
      } as AspectPreset;
    });

    if (presets.length === 1) {
      const [single] = presets;
      if (!single) return presets;
      const resolveKey = (candidate: AspectPreset | ImageSizeSelectorAspectOption) =>
        candidate.id ?? candidate.value ?? candidate.label;
      const singleKey = resolveKey(single);
      const matchUpload = singleKey === 'match-upload' || singleKey === 'keep-upload-aspect';
      if (matchUpload) {
        const existingKeys = new Set(presets.map((preset) => resolveKey(preset)));
        const fallbackPresets = DEFAULT_ASPECT_RATIO_PRESETS.filter((preset) => !existingKeys.has(resolveKey(preset)));
        if (fallbackPresets.length > 0) {
          return [...presets, ...fallbackPresets];
        }
      }
    }

    return presets;
  }, [aspectOptions]);
  useEffect(() => {
    if (!internalAspectKey) return;
    const exists = aspectPresets.some(
      (preset) => preset.value === internalAspectKey || preset.id === internalAspectKey || preset.label === internalAspectKey
    );
    if (!exists) {
      setInternalAspectKey(undefined);
    }
  }, [aspectPresets, internalAspectKey]);
  const { width, height } = parseResolution(value);
  const currentAspectRatio = width / height;
  const activeOption = pickNearestOption(resolvedOptions, width, height);
  const activePreset = useMemo(() => {
    if (aspectPresets.length === 0) return null;
    // 让 internalAspectKey 优先，因为它是同步更新的
    // 这样拖动滑块时不会因为外部状态异步更新而跳回原位
    const preferredKey =
      internalAspectKey ?? (typeof aspectValue === 'string' && aspectValue.length > 0 ? aspectValue : undefined);
    if (preferredKey) {
      const matched = aspectPresets.find(
        (preset) =>
          preset.value === preferredKey || preset.id === preferredKey || (preferredKey === preset.label && preferredKey.length > 0)
      );
      if (matched) return matched;
    }
    let fallback: AspectPreset | null = null;
    let nearest: AspectPreset | null = null;
    let minDiff = Number.POSITIVE_INFINITY;
    for (let index = 0; index < aspectPresets.length; index += 1) {
      const preset = aspectPresets[index];
      if (!fallback) {
        fallback = preset ?? null;
      }
      const ratio = (preset !== null && preset !== undefined ? preset.ratio : undefined);
      if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) {
        continue;
      }
      const diff = Math.abs(currentAspectRatio - ratio);
      if (diff < minDiff) {
        nearest = preset ?? null;
        minDiff = diff;
      }
    }
    return nearest ?? fallback;
  }, [aspectPresets, aspectValue, currentAspectRatio, internalAspectKey]);

  const activePresetIndex = useMemo(() => {
    if (aspectPresets.length === 0 || !activePreset) return 0;
    const index = aspectPresets.findIndex((preset) => preset.id === activePreset.id);
    return index >= 0 ? index : 0;
  }, [activePreset, aspectPresets]);

  const { t } = useTranslation(['components']);

  if (isConstrainedMode) {
    return (
      <ConstrainedImageSizeSelector
        value={value}
        label={label}
        onChange={onChange}
        disabled={disabled}
        allowAuto={allowAuto}
        sizeLevels={sizeLevels}
        aspectPresets={constrainedAspectPresets}
        presetOptions={presetOptions}
        constraints={constraints}
        variant={variant}
        popoverOpen={popoverOpen}
        onPopoverOpenChange={setPopoverOpen}
        formatAspectRatio={formatAspectRatio}
      />
    );
  }

  const orientation = orientationKey(width, height);
  const orientationLabel = (() => {
    switch (orientation) {
      case 'landscape':
        return t('imageSizeSelector.orientation.landscape', 'Landscape');
      case 'portrait':
        return t('imageSizeSelector.orientation.portrait', 'Portrait');
      default:
        return t('imageSizeSelector.orientation.square', 'Square');
    }
  })();

  const activeRatio = (() => {
    const presetRatio = activePreset !== null && activePreset !== undefined ? activePreset.ratio : undefined;
    if (typeof presetRatio === 'number' && Number.isFinite(presetRatio) && presetRatio > 0) {
      return presetRatio;
    }
    const resolution = (activePreset !== null && activePreset !== undefined ? activePreset.resolution : undefined);
    if (
      resolution &&
      typeof resolution.width === 'number' &&
      typeof resolution.height === 'number' &&
      resolution.width > 0 &&
      resolution.height > 0
    ) {
      return resolution.width / resolution.height;
    }
    return currentAspectRatio;
  })();

  const handleSizeChange = (nextValueStr: string) => {
    if (!nextValueStr) return;
    const nextValue = Number(nextValueStr);
    if (!Number.isFinite(nextValue)) return;
    const next = computeResolution(nextValue, activeRatio);
    const nextValueText = formatResolution(next.width, next.height);
    if (nextValueText !== value) {
      onChange(nextValueText);
    }
  };

  const handleAspectSliderIndexChange = (next: number) => {
    const preset = aspectPresets[next];
    if (!preset) return;
    const presetRatio = preset.ratio;
    const ratio = typeof presetRatio === 'number' && Number.isFinite(presetRatio) && presetRatio > 0 ? presetRatio : null;
    const resolution = (preset !== null && preset !== undefined ? preset.resolution : undefined);
    let formatted: string | undefined;
    if (
      resolution &&
      typeof resolution.width === 'number' &&
      typeof resolution.height === 'number' &&
      resolution.width > 0 &&
      resolution.height > 0
    ) {
      const width = Math.max(MIN_DIMENSION, Math.round(resolution.width));
      const height = Math.max(MIN_DIMENSION, Math.round(resolution.height));
      formatted = formatResolution(width, height);
      if (formatted !== value) {
        onChange(formatted);
      }
    } else if (ratio) {
      const next = computeResolution((activeOption !== null && activeOption !== undefined ? activeOption.value : undefined) ?? 2048, ratio);
      formatted = formatResolution(next.width, next.height);
      if (formatted !== value) {
        onChange(formatted);
      }
    }
    const nextAspectValue = (preset !== null && preset !== undefined ? preset.value : undefined) ?? (preset !== null && preset !== undefined ? preset.id : undefined);
    if (typeof onAspectValueChange === 'function') {
      onAspectValueChange(nextAspectValue, formatted ?? value);
    }
    const nextAspectKey = nextAspectValue ?? (preset !== null && preset !== undefined ? preset.label : undefined);
    if (nextAspectKey) {
      setInternalAspectKey(nextAspectKey);
    }
  };

  const aspectRatioLabel = (activePreset !== null && activePreset !== undefined ? activePreset.label : undefined) ?? formatAspectRatio(width, height);
  const aspectOrientationLabel = (activePreset !== null && activePreset !== undefined ? activePreset.description : undefined) ?? orientationLabel;

  // 紧凑模式：点击弹出 Popover，用于 Dock 场景
  if (variant === "compact") {
    // 紧凑模式下的完整选择器内容
    const compactSelectorContent = (
      <div className="w-[280px] p-2 space-y-4">
        {/* 尺寸选择 */}
        <div>
          <div className="text-xs font-medium mb-2">
            {t('imageSizeSelector.size', '尺寸')}
          </div>
          <ToggleGroup
            type="single"
            value={String((activeOption !== null && activeOption !== undefined ? activeOption.value : undefined) ?? 2048)}
            onValueChange={handleSizeChange}
            disabled={Boolean(disabled)}
            className="grid gap-1 grid-cols-2"
            variant="outline"
            spacing={0}
          >
            {resolvedOptions.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={String(option.value)}
                className="justify-center py-1.5 px-2"
              >
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-xs font-semibold leading-none">{option.label}</span>
                  <span className="text-[10px] text-muted-foreground leading-none">{option.value}px</span>
                </div>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        {/* 宽高比选择 */}
        <div>
          <div className="text-xs text-muted-foreground mb-2">
            {t('imageSizeSelector.aspectRatio', '宽高比')} {aspectRatioLabel} ({aspectOrientationLabel})
          </div>
          <Slider
            value={[activePresetIndex]}
            min={0}
            max={Math.max(aspectPresets.length - 1, 0)}
            step={1}
            onValueChange={(vals) => handleAspectSliderIndexChange(Array.isArray(vals) ? (vals[0] ?? 0) : Number(vals))}
            disabled={disabled || aspectPresets.length <= 1}
          />
          <div className="mt-1 text-[10px] text-muted-foreground">{(aspectPresets[activePresetIndex] !== null && aspectPresets[activePresetIndex] !== undefined ? aspectPresets[activePresetIndex].label : undefined)}</div>
        </div>

        {/* 最终分辨率 */}
        <div className="text-xs font-medium border-t pt-2">
          {t('imageSizeSelector.resolution', '分辨率')} {width} × {height}
        </div>
      </div>
    );

    return (
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="w-full min-w-0 justify-between gap-1 px-2 shrink overflow-hidden"
          >
            <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
              {(activeOption !== null && activeOption !== undefined ? activeOption.label : undefined) ?? ''} · {aspectRatioLabel}{' '}
              <span className="text-[10px] font-normal text-muted-foreground">
                ({width}×{height})
              </span>
            </span>
            <ChevronDown className="size-3 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="p-0">
          {compactSelectorContent}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <div className="w-full">
      {label ? <div className="text-sm font-medium mb-2">{label}</div> : null}
      <div className="flex flex-col gap-5">
        <ToggleGroup
          type="single"
          value={String(activeOption.value)}
          onValueChange={handleSizeChange}
          disabled={Boolean(disabled)}
          className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(112px,1fr))]"
          variant="outline"
          spacing={0}
        >
          {resolvedOptions.map((option) => (
            <ToggleGroupItem key={option.value} value={String(option.value)} className="justify-start items-start py-2 px-3">
              <div className="flex flex-col items-start gap-0.5">
                <span className="text-xs font-semibold leading-none">{option.label}</span>
                <span className="text-[11px] text-muted-foreground leading-none">{option.value}px</span>
              </div>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div>
          <div className="text-xs text-muted-foreground mb-2">
            {t('imageSizeSelector.aspectRatio', 'Aspect ratio')} {aspectRatioLabel} ({aspectOrientationLabel})
          </div>
          <Slider
            value={[activePresetIndex]}
            min={0}
            max={Math.max(aspectPresets.length - 1, 0)}
            step={1}
            onValueChange={(vals) => handleAspectSliderIndexChange(Array.isArray(vals) ? (vals[0] ?? 0) : Number(vals))}
            disabled={disabled || aspectPresets.length <= 1}
          />
          <div className="mt-1 text-[11px] text-muted-foreground">{(aspectPresets[activePresetIndex] !== null && aspectPresets[activePresetIndex] !== undefined ? aspectPresets[activePresetIndex].label : undefined)}</div>
        </div>
        <div className="text-sm font-medium">
          {t('imageSizeSelector.resolution', 'Resolution')} {width} × {height}
        </div>
      </div>
    </div>
  );
};

export default ImageSizeSelector;
