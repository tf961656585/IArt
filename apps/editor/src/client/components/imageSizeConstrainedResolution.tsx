import React, { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import {
  computeByPixelBudgetAndAspect,
  findNearestConstrainedResolution,
  formatResolution,
  isValidConstrainedResolution,
  normalizeConstraints,
  parseResolution,
  resolveAspectRatioFromResolution,
  type ImageSizeResolution,
  type ImageSizeSelectorConstrainedAspectPreset,
  type ImageSizeSelectorConstrainedConstraints,
  type ImageSizeSelectorConstrainedPresetOption,
  type ImageSizeSelectorConstrainedSizeLevel,
} from './imageSizeConstrainedResolutionMath';

export type {
  ImageSizeSelectorConstrainedAspectPreset,
  ImageSizeSelectorConstrainedConstraints,
  ImageSizeSelectorConstrainedPresetOption,
  ImageSizeSelectorConstrainedSizeLevel,
} from './imageSizeConstrainedResolutionMath';

export type ConstrainedImageSizeSelectorProps = {
  value: string | undefined | undefined;
  label: string | undefined | undefined;
  onChange: (next: string) => void;
  disabled: boolean | undefined | undefined;
  allowAuto: boolean | undefined | undefined;
  sizeLevels: ImageSizeSelectorConstrainedSizeLevel[] | undefined | undefined;
  aspectPresets: ImageSizeSelectorConstrainedAspectPreset[] | undefined | undefined;
  presetOptions: ImageSizeSelectorConstrainedPresetOption[] | undefined | undefined;
  constraints: ImageSizeSelectorConstrainedConstraints | undefined | undefined;
  variant: 'default' | 'compact' | undefined | undefined;
  popoverOpen: boolean;
  onPopoverOpenChange: (next: boolean) => void;
  formatAspectRatio: (width: number, height: number) => string;
};

const FALLBACK_SIZE_LEVEL: ImageSizeSelectorConstrainedSizeLevel = { id: '2k', label: '2K', pixelBudget: 2048 * 2048 };
const FALLBACK_ASPECT_PRESET: ImageSizeSelectorConstrainedAspectPreset = { id: '1:1', label: '1:1', ratio: 1 };

const DEFAULT_SIZE_LEVELS: ImageSizeSelectorConstrainedSizeLevel[] = [
  { id: '1k', label: '1K', pixelBudget: 1024 * 1024 },
  { id: '2k', label: '2K', pixelBudget: 2048 * 2048 },
];

const DEFAULT_ASPECT_PRESETS: ImageSizeSelectorConstrainedAspectPreset[] = [
  FALLBACK_ASPECT_PRESET,
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
];

/** 比例命中预设的相对容差：取整后的分辨率比例与预设比例允许 2% 以内的偏差 */
const ASPECT_MATCH_TOLERANCE = 0.02;

const normalizeLevels = (
  levels: ImageSizeSelectorConstrainedSizeLevel[] | undefined,
  constraints: ImageSizeSelectorConstrainedConstraints,
) => {
  const source =
    levels !== null && levels !== undefined && levels.length > 0 ? levels : DEFAULT_SIZE_LEVELS;
  return source
    .filter((level) => level.id && Number.isFinite(level.pixelBudget) && level.pixelBudget > 0)
    .map((level) => ({
      id: level.id,
      label: level.label || level.id,
      pixelBudget: Math.min(level.pixelBudget, constraints.maxPixels),
    }))
    .filter((level) => level.pixelBudget >= constraints.minPixels);
};

const normalizeAspectPresets = (
  presets: ImageSizeSelectorConstrainedAspectPreset[] | undefined,
  constraints: ImageSizeSelectorConstrainedConstraints,
) => {
  const source =
    presets !== null && presets !== undefined && presets.length > 0 ? presets : DEFAULT_ASPECT_PRESETS;
  return source
    .filter((preset) => preset.id && Number.isFinite(preset.ratio) && preset.ratio > 0)
    .filter((preset) => {
      const longShortRatio = preset.ratio >= 1 ? preset.ratio : 1 / preset.ratio;
      return longShortRatio <= constraints.maxAspectRatio;
    })
    .map((preset) => ({ ...preset, label: preset.label || preset.id }));
};

const formatMegapixels = (width: number, height: number) => {
  const megapixels = (width * height) / 1_000_000;
  return `${megapixels >= 10 ? megapixels.toFixed(1) : megapixels.toFixed(2)}MP`;
};

/** 约分比例过长时（如 40:17）改用十进制比值显示，避免难读的长分数 */
const formatDisplayRatio = (
  width: number,
  height: number,
  formatAspectRatio: (width: number, height: number) => string,
) => {
  const reduced = formatAspectRatio(width, height);
  if (reduced.length <= 5) return reduced;
  const ratio = width / height;
  return ratio >= 1
    ? `${Number.parseFloat(ratio.toFixed(2))}:1`
    : `1:${Number.parseFloat((1 / ratio).toFixed(2))}`;
};

const summarizeResolution = (
  resolution: ImageSizeResolution,
  formatAspectRatio: (width: number, height: number) => string,
) => `${resolution.width} × ${resolution.height} · ${formatDisplayRatio(resolution.width, resolution.height, formatAspectRatio)} · ${formatMegapixels(resolution.width, resolution.height)}`;

const pickNearestLevel = (
  levels: ImageSizeSelectorConstrainedSizeLevel[],
  resolution: ImageSizeResolution,
) => {
  const pixels = resolution.width * resolution.height;
  const [first, ...rest] = levels;
  const fallback = first ?? FALLBACK_SIZE_LEVEL;
  return rest.reduce((best, level) => (
    Math.abs(level.pixelBudget - pixels) < Math.abs(best.pixelBudget - pixels) ? level : best
  ), fallback);
};

/** 当前比例命中某个预设（容差内最近）时返回该预设，否则返回 null 表示自定义比例 */
const matchAspectPreset = (
  presets: ImageSizeSelectorConstrainedAspectPreset[],
  ratio: number,
): ImageSizeSelectorConstrainedAspectPreset | null => {
  let nearest: ImageSizeSelectorConstrainedAspectPreset | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const preset of presets) {
    const distance = Math.abs(Math.log(preset.ratio / ratio));
    if (distance < nearestDistance) {
      nearest = preset;
      nearestDistance = distance;
    }
  }
  return nearest !== null && nearestDistance <= Math.log(1 + ASPECT_MATCH_TOLERANCE) ? nearest : null;
};

const parseAspectRatioInput = (raw: string): number | null => {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number.parseFloat(match[1] ?? '');
  const height = Number.parseFloat(match[2] ?? '');
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return width / height;
};

/**
 * 只投影、不提交：把当前 value 解析为用于显示的分辨率。
 * 合法值原样显示；不合法/缺失值显示其归一化投影，但不写回（用户交互时才写入）。
 */
const projectCurrentValue = (
  raw: string | undefined,
  constraints: ImageSizeSelectorConstrainedConstraints,
  allowAuto: boolean,
) => {
  if (raw === 'auto' && allowAuto) {
    return { kind: 'auto' as const, resolution: { width: 2048, height: 2048 } };
  }
  const parsed = parseResolution(raw);
  const resolution = parsed
    ? isValidConstrainedResolution(parsed, constraints)
      ? parsed
      : findNearestConstrainedResolution(parsed.width, parsed.height, constraints)
    : findNearestConstrainedResolution(2048, 2048, constraints);
  return { kind: 'resolution' as const, resolution };
};

function MiniToggleItem({
  value,
  label,
  sublabel = undefined,
  className = undefined,
}: {
  value: string;
  label: string;
} & Partial<{
  sublabel: string | undefined;
  className: string | undefined;
}>) {
  return (
    <ToggleGroupItem value={value} className={cn('h-8 min-w-0 justify-center px-2 text-xs', className)}>
      <span className="whitespace-nowrap font-medium">{label}</span>
      {sublabel ? <span className="ml-1 truncate text-[10px] text-muted-foreground">{sublabel}</span> : null}
    </ToggleGroupItem>
  );
}

export function ConstrainedImageSizeSelector({
  value,
  label,
  onChange,
  disabled,
  allowAuto,
  sizeLevels,
  aspectPresets,
  presetOptions,
  constraints,
  variant = 'default',
  popoverOpen,
  onPopoverOpenChange,
  formatAspectRatio,
}: ConstrainedImageSizeSelectorProps) {
  const resolvedConstraints = useMemo(() => normalizeConstraints(constraints), [constraints]);
  const resolvedAllowAuto = allowAuto === true;
  const levels = useMemo(() => normalizeLevels(sizeLevels, resolvedConstraints), [resolvedConstraints, sizeLevels]);
  const presets = useMemo(() => normalizeAspectPresets(aspectPresets, resolvedConstraints), [aspectPresets, resolvedConstraints]);
  const projected = useMemo(
    () => projectCurrentValue(value, resolvedConstraints, resolvedAllowAuto),
    [resolvedAllowAuto, resolvedConstraints, value],
  );

  // 选中态每次渲染从当前 value 推导，撤销/重做/项目重开后不会陈旧
  const derived = useMemo(() => {
    const activeLevel = pickNearestLevel(levels, projected.resolution);
    const currentRatio = resolveAspectRatioFromResolution(projected.resolution.width, projected.resolution.height);
    const matchedPreset = matchAspectPreset(presets, currentRatio);
    return { activeLevel, currentRatio, matchedPreset };
  }, [levels, presets, projected.resolution]);

  // 自定义比例输入草稿：null 表示未在编辑，显示推导比例
  const [ratioDraft, setRatioDraft] = useState<string | null>(null);

  const autoPresetOption =
    presetOptions !== null && presetOptions !== undefined
      ? presetOptions.find((option) => option.value === 'auto')
      : undefined;
  const autoLabel = (autoPresetOption !== null && autoPresetOption !== undefined ? autoPresetOption.label : undefined) ?? 'Auto';

  const derivedRatioText = derived.matchedPreset !== null
    ? derived.matchedPreset.id
    : formatDisplayRatio(projected.resolution.width, projected.resolution.height, formatAspectRatio);
  const effectiveRatio = derived.matchedPreset !== null ? derived.matchedPreset.ratio : derived.currentRatio;

  const commitResolution = (resolution: ImageSizeResolution) => {
    const nextValue = formatResolution(resolution.width, resolution.height);
    if (nextValue !== value) onChange(nextValue);
  };

  const handleAuto = () => {
    if (resolvedAllowAuto && value !== 'auto') onChange('auto');
  };

  const handleLevelChange = (nextLevelId: string) => {
    const nextLevel = levels.find((item) => item.id === nextLevelId);
    if (!nextLevel) return;
    commitResolution(computeByPixelBudgetAndAspect(nextLevel.pixelBudget, effectiveRatio, resolvedConstraints));
  };

  const handleAspectPresetChange = (nextAspectId: string) => {
    const nextAspect = presets.find((item) => item.id === nextAspectId);
    if (!nextAspect) return;
    commitResolution(computeByPixelBudgetAndAspect(derived.activeLevel.pixelBudget, nextAspect.ratio, resolvedConstraints));
  };

  const handleCustomRatioCommit = () => {
    const draft = ratioDraft;
    setRatioDraft(null);
    if (draft === null) return;
    const parsedRatio = parseAspectRatioInput(draft);
    if (parsedRatio === null) {
      // 非法输入不写入，保持原值
      console.debug('[ConstrainedImageSizeSelector] 忽略非法自定义比例输入:', draft);
      return;
    }
    const clampedRatio = Math.min(
      Math.max(parsedRatio, 1 / resolvedConstraints.maxAspectRatio),
      resolvedConstraints.maxAspectRatio,
    );
    commitResolution(computeByPixelBudgetAndAspect(derived.activeLevel.pixelBudget, clampedRatio, resolvedConstraints));
  };

  const activeSummary = projected.kind === 'auto'
    ? autoLabel
    : summarizeResolution(projected.resolution, formatAspectRatio);

  const content = (
    <div className={cn('space-y-3', variant === 'compact' ? 'w-full p-2' : 'w-full')}>
      {resolvedAllowAuto ? (
        <Button
          type="button"
          variant={projected.kind === 'auto' ? 'secondary' : 'outline'}
          size="xs"
          className="h-7 w-full text-xs"
          disabled={disabled}
          onClick={handleAuto}
        >
          {autoLabel}
        </Button>
      ) : null}
      <div className="space-y-2">
        <ToggleGroup
          type="single"
          value={derived.activeLevel.id}
          onValueChange={(next) => next && handleLevelChange(next)}
          disabled={Boolean(disabled)}
          className="grid w-full grid-cols-3 gap-1"
          variant="outline"
          spacing={1}
        >
          {levels.map((level) => <MiniToggleItem key={level.id} value={level.id} label={level.label} />)}
        </ToggleGroup>
        <div className="flex flex-wrap items-center gap-1">
          <ToggleGroup
            type="single"
            value={derived.matchedPreset !== null ? derived.matchedPreset.id : ''}
            onValueChange={(next) => next && handleAspectPresetChange(next)}
            disabled={Boolean(disabled)}
            className="flex min-w-0 flex-1 flex-wrap gap-1"
            variant="outline"
            spacing={1}
          >
            {presets.map((preset) => (
              <MiniToggleItem key={preset.id} value={preset.id} label={preset.label} className="flex-1 basis-12" />
            ))}
          </ToggleGroup>
          <Input
            aria-label="Custom aspect ratio"
            type="text"
            inputMode="text"
            placeholder="W:H"
            value={ratioDraft ?? derivedRatioText}
            disabled={disabled}
            className="h-8 w-20 shrink-0 px-2 text-center text-xs"
            onFocus={() => setRatioDraft(ratioDraft ?? derivedRatioText)}
            onChange={(event) => setRatioDraft(event.target.value)}
            onBlur={handleCustomRatioCommit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleCustomRatioCommit();
              }
            }}
          />
        </div>
      </div>
      <div className="truncate border-t pt-2 text-xs font-medium">{activeSummary}</div>
    </div>
  );

  if (variant === 'compact') {
    return (
      <Popover open={popoverOpen} onOpenChange={onPopoverOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="h-8 w-full min-w-0 justify-between gap-1 px-2 shrink overflow-hidden"
          >
            <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">{activeSummary}</span>
            <ChevronDown className="size-3 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[300px] p-0">
          {content}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <div className="w-full">
      {label ? <div className="mb-2 text-sm font-medium">{label}</div> : null}
      {content}
    </div>
  );
}
