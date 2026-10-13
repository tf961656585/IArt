'use client';

import { useCallback, useState, type KeyboardEvent, type ReactNode } from 'react';

import type { ExecutableCatalogParameterField } from '@iart/contracts';
import type { DynamicPayload } from '@/client/api/clientTypes';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ParamTranslate } from '../promptDockParamModel';
import { resolveParamLabel } from '../promptDockParamModel';
import type {
  FrameConstrainedMode,
  FrameConstrainedProps,
  FrameOptionLabelResolver,
  FrameSpec,
} from '../promptDockFrameModel';
import {
  checkConstrainedDims,
  compareFrameGridOptions,
  composeConstrainedSize,
  formatConstraintSummary,
  frameChipText,
  parseDimsValue,
  parseRatioValue,
  ratioFraction,
  resolveConstrainedState,
} from '../promptDockFrameModel';

/**
 * PromptDock 画幅控件（chip + popover，原型 prototypes/shared/promptdock-frame.js 的
 * Editor 落地）。chip 触发器复用 inline 参数行控件形态；popover 承载比例网格 +
 * 分辨率/尺寸档段控 + 派生信息 foot，弹层口径与 Dock 内其他弹层一致
 * （side=top / align=start / z-dock-popover）。
 *
 * 写回走 draft.arguments 既有 param key（frameSpec 派生自运行时 schema，
 * 不建第二参数事实源）；auto/adaptive 虚线方框、不伪造精确像素（设计红线）。
 */

type FrameControlProps = {
  spec: FrameSpec;
  args: DynamicPayload;
  translate: ParamTranslate;
  /** 单参数写回（fieldKey -> 下一值），由调用方落 draft.arguments */
  onChange: (fieldKey: string, next: unknown) => void;
};

type FrameGridOption = {
  value: string;
  label: string;
  /** null = auto/adaptive 虚线方框（跟随语义） */
  dims: [number, number] | null;
  disabled: boolean;
  why: string | null;
};

type FrameSegOption = {
  value: string;
  label: string;
  disabled: boolean;
  why: string | null;
};

/** 诚实按真实宽高比 fit 渲染；dims null = 虚线方框。
 *  boxHeight = 外框容器高（原型 .frame-box 34px），fitHeight = fit 计算上限
 *  （原型 appendGrid 5 列传 32），两者分离与原型口径一致；
 *  selected 画框边框走 --st-generating 实色（原型 .frame-cell.selected .frame-rect）。 */
function FrameBox({
  dims,
  boxHeight,
  fitHeight,
  selected,
}: {
  dims: [number, number] | null;
  boxHeight: number;
  fitHeight?: number;
  selected?: boolean;
}) {
  const fit = fitHeight ?? boxHeight;
  const selectedBorder = 'border-(--st-generating)';
  if (dims === null) {
    return (
      <span className="flex items-center justify-center" style={{ height: boxHeight }}>
        <span
          className={`size-6 rounded-[2px] border-[1.5px] border-dashed ${
            selected ? selectedBorder : 'border-[color-mix(in_srgb,var(--foreground)_50%,transparent)]'
          }`}
        />
      </span>
    );
  }
  const [ratioWidth, ratioHeight] = dims;
  const scale = Math.min(44 / ratioWidth, fit / ratioHeight);
  return (
    <span className="flex items-center justify-center" style={{ height: boxHeight }}>
      <span
        className={`rounded-[2px] border-[1.5px] ${
          selected ? selectedBorder : 'border-[color-mix(in_srgb,var(--foreground)_60%,transparent)]'
        }`}
        style={{ width: Math.max(ratioWidth * scale, 2), height: Math.max(ratioHeight * scale, 2) }}
      />
    </span>
  );
}

/** roving tabindex：方向键在全部格间移动（含禁用格，保证 why 可达），聚焦即选中。 */
const useRovingKeyDown = (cols: number) => {
  return useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const items = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      );
      if (items.length < 2) return;
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (event.key === 'Home') {
        next = 0;
      } else if (event.key === 'End') {
        next = items.length - 1;
      } else {
        let delta = 0;
        if (event.key === 'ArrowRight') delta = 1;
        else if (event.key === 'ArrowLeft') delta = -1;
        else if (event.key === 'ArrowDown' && cols > 1) delta = cols;
        else if (event.key === 'ArrowUp' && cols > 1) delta = -cols;
        else return;
        next = (index + delta + items.length) % items.length;
      }
      event.preventDefault();
      items[next]?.focus();
    },
    [cols],
  );
};

function FrameRatioGrid({
  options,
  current,
  onSelect,
}: {
  options: FrameGridOption[];
  current: string | null;
  onSelect: (value: string) => void;
}) {
  const sorted = [...options].sort(compareFrameGridOptions);
  const cols = sorted.length < 5 ? Math.max(sorted.length, 1) : 5;
  const handleKeyDown = useRovingKeyDown(cols);
  return (
    <div
      role="radiogroup"
      aria-label="画幅比例"
      tabIndex={-1}
      className="grid gap-1 px-2 pb-1"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      onKeyDown={handleKeyDown}
    >
      {sorted.map((option) => {
        const selected = option.value === current;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={selected}
            aria-disabled={option.disabled || undefined}
            title={option.why ?? undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!option.disabled) onSelect(option.value);
            }}
            className={`flex cursor-pointer flex-col items-center gap-[3px] rounded-[6px] border border-transparent px-0.5 pb-[5px] pt-1.5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-(--chrome-ring) ${
              option.disabled ? 'cursor-not-allowed opacity-55' : ''
            } ${
              selected
                ? 'border-[color-mix(in_srgb,var(--st-generating)_45%,transparent)] bg-[color-mix(in_srgb,var(--st-generating)_10%,transparent)]'
                : ''
            }`}
          >
            <FrameBox dims={option.dims} boxHeight={34} fitHeight={32} selected={selected} />
            <span
              className={`text-[10px] leading-tight whitespace-nowrap tabular-nums ${
                selected ? 'font-semibold text-foreground' : 'text-muted-foreground'
              }`}
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FrameSegmented({
  options,
  current,
  ariaLabel,
  onSelect,
}: {
  options: FrameSegOption[];
  current: string | null;
  ariaLabel: string;
  onSelect: (value: string) => void;
}) {
  const handleKeyDown = useRovingKeyDown(1);
  return (
    <div role="radiogroup" aria-label={ariaLabel} tabIndex={-1} className="flex gap-1 px-2 pb-1" onKeyDown={handleKeyDown}>
      {options.map((option) => {
        const selected = option.value === current;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={selected}
            aria-disabled={option.disabled || undefined}
            title={option.why ?? undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!option.disabled) onSelect(option.value);
            }}
            className={`h-[26px] min-w-0 flex-1 cursor-pointer rounded-[6px] border border-transparent px-1 text-[11px] whitespace-nowrap transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-(--chrome-ring) ${
              option.disabled ? 'cursor-not-allowed opacity-55' : ''
            } ${
              selected
                ? 'border-[color-mix(in_srgb,var(--st-generating)_40%,transparent)] bg-[color-mix(in_srgb,var(--st-generating)_12%,transparent)] font-semibold text-foreground'
                : 'text-foreground'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const FrameGroupLabel = ({ text }: { text: string }) => (
  <div className="px-3.5 pb-[3px] pt-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
    {text}
  </div>
);

/** 派生信息 foot（原型 .frame-foot：通栏顶边框 + 10px 水平内缩 + 22px 最小高度） */
const FrameFoot = ({ children }: { children: ReactNode }) => (
  <div
    className="flex min-h-[22px] flex-wrap items-center gap-2 border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground"
    aria-live="polite"
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// constrained 主体（预设档 / 比例×总像素档 / 自定义 W×H 三模式）
// ---------------------------------------------------------------------------

type FrameConstrainedInteraction = {
  mode: FrameConstrainedMode;
  presetValue: string | null;
  ratioId: string | null;
  levelId: string | null;
  customWidth: string;
  customHeight: string;
};

const initConstrainedInteraction = (
  value: unknown,
  props: FrameConstrainedProps,
): FrameConstrainedInteraction => {
  const resolved = resolveConstrainedState(value, props);
  return {
    mode: resolved.mode,
    presetValue: resolved.presetValue,
    ratioId: resolved.ratioId,
    levelId: resolved.levelId,
    customWidth: resolved.customWidth === null ? '' : String(resolved.customWidth),
    customHeight: resolved.customHeight === null ? '' : String(resolved.customHeight),
  };
};

function FrameConstrainedBody({
  spec,
  args,
  translate,
  onChange,
}: Omit<FrameControlProps, 'spec'> & { spec: Extract<FrameSpec, { kind: 'constrained' }> }) {
  const props = spec.props;
  // popover 每次打开重新挂载（radix 默认卸载内容），交互态只在挂载时由提交值反推一次；
  // 打开期间模式切换/输入不回灌反推，避免输入中途被合成值反解拽回其他模式。
  const [interaction, setInteraction] = useState<FrameConstrainedInteraction>(() =>
    initConstrainedInteraction(args[spec.field.fieldKey], props),
  );

  const composeValid = useCallback(
    (aspectId: string, levelId: string): { width: number; height: number } | null => {
      const composed = composeConstrainedSize(props, aspectId, levelId);
      if (!composed) return null;
      return checkConstrainedDims(composed.width, composed.height, props.constraints).length === 0
        ? composed
        : null;
    },
    [props],
  );

  const selectPreset = (presetValue: string) => {
    setInteraction((prev) => ({ ...prev, mode: 'preset', presetValue }));
    onChange(spec.field.fieldKey, presetValue);
  };

  const selectRatio = (aspectId: string) => {
    // 比例联动：当前档在新比例下非法（官方约束）时自动落回总像素最近的合法档（原型 gpt2Sync 口径）
    let levelId = interaction.levelId;
    if (levelId === null || composeValid(aspectId, levelId) === null) {
      const currentLevel = props.sizeLevels.find((level) => level.id === interaction.levelId);
      const fallback = props.sizeLevels
        .slice()
        .sort(
          (a, b) =>
            Math.abs(a.pixelBudget - (currentLevel?.pixelBudget ?? 0)) -
            Math.abs(b.pixelBudget - (currentLevel?.pixelBudget ?? 0)),
        )
        .find((level) => composeValid(aspectId, level.id) !== null);
      levelId = fallback?.id ?? null;
    }
    setInteraction((prev) => ({ ...prev, mode: 'ratio', ratioId: aspectId, levelId }));
    if (levelId !== null) {
      const composed = composeValid(aspectId, levelId);
      if (composed) onChange(spec.field.fieldKey, `${composed.width}x${composed.height}`);
    }
  };

  const selectLevel = (levelId: string) => {
    setInteraction((prev) => ({ ...prev, mode: 'ratio', levelId }));
    if (interaction.ratioId !== null) {
      const composed = composeValid(interaction.ratioId, levelId);
      if (composed) onChange(spec.field.fieldKey, `${composed.width}x${composed.height}`);
    }
  };

  const updateCustomInput = (axis: 'customWidth' | 'customHeight', raw: string) => {
    const next = { ...interaction, [axis]: raw };
    setInteraction(next);
    // 自由尺寸只在「可解析且过官方约束」时写回草稿，避免提交链吃进非法中间态；
    // 未写回时校验行给出 ✗ 违例原因引导修正。
    const width = Number.parseInt(next.customWidth, 10);
    const height = Number.parseInt(next.customHeight, 10);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return;
    if (checkConstrainedDims(width, height, props.constraints).length > 0) return;
    onChange(spec.field.fieldKey, `${width}x${height}`);
  };

  /** 常见宽高预设：回填两侧输入框，写回口径与 updateCustomInput 一致（非法不写回，校验行给原因）。 */
  const applyCustomPreset = (presetValue: string) => {
    const dims = parseDimsValue(presetValue);
    if (!dims) return;
    const [width, height] = dims;
    setInteraction((prev) => ({
      ...prev,
      mode: 'custom',
      customWidth: String(width),
      customHeight: String(height),
    }));
    if (checkConstrainedDims(width, height, props.constraints).length === 0) {
      onChange(spec.field.fieldKey, presetValue);
    }
  };

  const modeItems: FrameSegOption[] = [
    ...props.presetOptions.map((preset) => ({
      value: `preset:${preset.value}`,
      label: resolveParamLabel(translate, preset.label, preset.value),
      disabled: false,
      why: null,
    })),
    { value: 'ratio', label: '比例 × 分辨率', disabled: false, why: null },
    { value: 'custom', label: '自定义 W×H', disabled: false, why: null },
  ];
  const currentModeValue =
    interaction.mode === 'preset' && interaction.presetValue !== null
      ? `preset:${interaction.presetValue}`
      : interaction.mode;

  const ratioOptions: FrameGridOption[] = props.aspectPresets.map((aspect) => ({
    value: aspect.id,
    label: resolveParamLabel(translate, aspect.label, aspect.id),
    dims: parseRatioValue(aspect.id) ?? [Math.round(aspect.ratio * 100), 100],
    disabled: false,
    why: null,
  }));

  const composed =
    interaction.mode === 'ratio' && interaction.ratioId !== null && interaction.levelId !== null
      ? composeConstrainedSize(props, interaction.ratioId, interaction.levelId)
      : null;

  const levelItems: FrameSegOption[] = props.sizeLevels.map((level) => {
    const label = resolveParamLabel(translate, level.label, level.id);
    const composedForLevel =
      interaction.ratioId !== null ? composeConstrainedSize(props, interaction.ratioId, level.id) : null;
    const errors =
      composedForLevel === null
        ? ['这个尺寸组合不可用']
        : checkConstrainedDims(composedForLevel.width, composedForLevel.height, props.constraints);
    return errors.length === 0 && composedForLevel !== null
      ? {
          value: level.id,
          label: `${label} · ${composedForLevel.width}×${composedForLevel.height}`,
          disabled: false,
          why: null,
        }
      : { value: level.id, label, disabled: true, why: errors.join('；') };
  });

  const customWidth = Number.parseInt(interaction.customWidth, 10);
  const customHeight = Number.parseInt(interaction.customHeight, 10);
  const customDimsValid =
    Number.isInteger(customWidth) && Number.isInteger(customHeight) && customWidth > 0 && customHeight > 0;
  const customErrors = customDimsValid
    ? checkConstrainedDims(customWidth, customHeight, props.constraints)
    : [];
  const customFraction = customDimsValid ? ratioFraction(customWidth, customHeight) : null;
  // 预设选中态由当前宽高精确匹配派生（手改任一侧即回到占位符，不残留旧选中）
  const matchedCustomPreset = customDimsValid
    ? props.customPresets.find((preset) => {
        const dims = parseDimsValue(preset.value);
        return dims !== null && dims[0] === customWidth && dims[1] === customHeight;
      })
    : undefined;

  return (
    <>
      <FrameGroupLabel text="模式" />
      <FrameSegmented
        options={modeItems}
        current={currentModeValue}
        ariaLabel="尺寸模式"
        onSelect={(value) => {
          if (value.startsWith('preset:')) {
            selectPreset(value.slice('preset:'.length));
          } else if (value === 'ratio') {
            // 切入 ratio 模式即按当前比例×档位合成写回（原型 frameSwitchMode 口径）
            const aspectId = interaction.ratioId ?? props.aspectPresets[0]?.id ?? null;
            const levelId = interaction.levelId ?? props.sizeLevels[0]?.id ?? null;
            setInteraction((prev) => ({ ...prev, mode: 'ratio', ratioId: aspectId, levelId }));
            if (aspectId !== null && levelId !== null) {
              const composedSwitch = composeValid(aspectId, levelId);
              if (composedSwitch) {
                onChange(spec.field.fieldKey, `${composedSwitch.width}x${composedSwitch.height}`);
              }
            }
          } else {
            setInteraction((prev) => ({ ...prev, mode: 'custom' }));
          }
        }}
      />

      {interaction.mode === 'ratio' ? (
        <>
          <FrameGroupLabel text="比例" />
          <FrameRatioGrid options={ratioOptions} current={interaction.ratioId} onSelect={selectRatio} />
          <FrameGroupLabel text="分辨率 · 总像素档" />
          <FrameSegmented
            options={levelItems}
            current={interaction.levelId}
            ariaLabel="分辨率"
            onSelect={selectLevel}
          />
          {composed ? (
            <FrameFoot>
              <span className="font-mono text-foreground tabular-nums">
                输出 {composed.width}×{composed.height}
              </span>
            </FrameFoot>
          ) : null}
        </>
      ) : null}

      {interaction.mode === 'custom' ? (
        <>
          <FrameGroupLabel text="尺寸" />
          <div className="flex flex-col gap-1.5 px-2 pb-1.5 pt-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                type="number"
                aria-label="宽度"
                value={interaction.customWidth}
                onChange={(event) => updateCustomInput('customWidth', event.target.value)}
                className="h-[26px] w-[62px] rounded-lg border border-border bg-background/40 px-2 text-center text-[11px] focus-visible:outline-2 focus-visible:outline-(--chrome-ring)"
              />
              <span aria-hidden="true" className="text-[11px] text-muted-foreground">
                ×
              </span>
              <input
                type="number"
                aria-label="高度"
                value={interaction.customHeight}
                onChange={(event) => updateCustomInput('customHeight', event.target.value)}
                className="h-[26px] w-[62px] rounded-lg border border-border bg-background/40 px-2 text-center text-[11px] focus-visible:outline-2 focus-visible:outline-(--chrome-ring)"
              />
              {props.customPresets.length > 0 ? (
                <Select value={matchedCustomPreset?.value ?? ''} onValueChange={applyCustomPreset}>
                  <SelectTrigger
                    size="sm"
                    aria-label="常见宽高"
                    className="h-[26px] gap-1.5 rounded-lg border-border bg-background/40 px-2 text-[11px] whitespace-nowrap"
                  >
                    <SelectValue placeholder="常见宽高…" />
                  </SelectTrigger>
                  {/* 同 Dock 弹层口径：向上弹、左缘对齐、z 高于 Dock 卡片 z-dock */}
                  <SelectContent
                    side="top"
                    align="start"
                    sideOffset={6}
                    collisionPadding={8}
                    className="z-dock-popover max-h-[280px]"
                  >
                    {props.customPresets.map((preset) => {
                      const dims = parseDimsValue(preset.value);
                      return (
                        <SelectItem key={preset.value} value={preset.value}>
                          {resolveParamLabel(
                            translate,
                            preset.label,
                            dims ? `${dims[0]}×${dims[1]}` : preset.value,
                          )}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              {customDimsValid && customFraction !== null ? (
                <>
                  <FrameBox dims={[customWidth, customHeight]} boxHeight={28} fitHeight={26} />
                  <span className="font-mono tabular-nums">
                    比例 {customFraction} · {(customWidth / customHeight).toFixed(2)}:1
                  </span>
                </>
              ) : (
                <span className="font-mono tabular-nums">比例 —（输入合法宽高后显示）</span>
              )}
            </div>
            <div
              className="mt-0.5 min-h-[14px] font-mono text-[10px] tabular-nums"
              aria-live="polite"
            >
              {customErrors.length > 0 ? (
                <span className="text-(--st-failed-text)">✗ {customErrors.join('；')}</span>
              ) : customDimsValid ? (
                <span className="text-(--st-succeeded)">✓ 已应用 {customWidth}×{customHeight}</span>
              ) : null}
            </div>
          </div>
          <FrameFoot>{formatConstraintSummary(props.constraints)}</FrameFoot>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// combo 主体（ratio 族 select + size 族 select 双轴写回）
// ---------------------------------------------------------------------------

function FrameComboBody({
  spec,
  args,
  translate,
  onChange,
}: Omit<FrameControlProps, 'spec'> & { spec: Extract<FrameSpec, { kind: 'combo' }> }) {
  const resolveOptionLabel: FrameOptionLabelResolver = useCallback(
    (field: ExecutableCatalogParameterField, value: string) => {
      const option = (field.enumOptions ?? []).find((candidate) => String(candidate.value) === value);
      return resolveParamLabel(translate, option?.label, value);
    },
    [translate],
  );

  const ratioOptions: FrameGridOption[] = (spec.ratioField.enumOptions ?? []).map((option) => {
    const value = String(option.value);
    return { value, label: value, dims: parseRatioValue(value), disabled: false, why: null };
  });
  const currentRatioRaw = args[spec.ratioField.fieldKey];
  const currentRatio = currentRatioRaw === undefined || currentRatioRaw === null ? null : String(currentRatioRaw);

  const sizeOptions: FrameSegOption[] = (spec.sizeField.enumOptions ?? []).map((option) => {
    const value = String(option.value);
    return { value, label: resolveOptionLabel(spec.sizeField, value), disabled: false, why: null };
  });
  const currentSizeRaw = args[spec.sizeField.fieldKey];
  const currentSize = currentSizeRaw === undefined || currentSizeRaw === null ? null : String(currentSizeRaw);

  const sizeAxisLabel = spec.sizeField.fieldKey.toLowerCase() === 'resolution' ? '分辨率' : '尺寸档';

  return (
    <>
      <FrameGroupLabel text="比例" />
      <FrameRatioGrid
        options={ratioOptions}
        current={currentRatio}
        onSelect={(value) => onChange(spec.ratioField.fieldKey, value)}
      />
      <FrameGroupLabel text={sizeAxisLabel} />
      <FrameSegmented
        options={sizeOptions}
        current={currentSize}
        ariaLabel={sizeAxisLabel}
        onSelect={(value) => onChange(spec.sizeField.fieldKey, value)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 对外组件：chip 触发器 + popover
// ---------------------------------------------------------------------------

export function PromptDockFrameControl({ spec, args, translate, onChange }: FrameControlProps) {
  const [open, setOpen] = useState(false);

  const resolveOptionLabel: FrameOptionLabelResolver = useCallback(
    (field: ExecutableCatalogParameterField, value: string) => {
      const option = (field.enumOptions ?? []).find((candidate) => String(candidate.value) === value);
      return resolveParamLabel(translate, option?.label, value);
    },
    [translate],
  );

  const chipText = frameChipText(spec, args, resolveOptionLabel);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="画幅 · 比例与尺寸"
          aria-haspopup="dialog"
          data-testid="promptdock-frame-chip"
          className="inline-flex h-7 max-w-[220px] min-w-0 items-center gap-1.5 rounded-lg border border-border bg-background/40 px-2 text-[11px] whitespace-nowrap outline-none hover:border-input focus-visible:border-(--chrome-ring) focus-visible:outline-2 focus-visible:outline-(--chrome-ring)"
        >
          <span className="text-muted-foreground">画幅</span>
          <span className="min-w-0 truncate font-mono text-foreground tabular-nums">{chipText}</span>
          <span aria-hidden="true" className="text-[9px] text-muted-foreground">
            ▼
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="z-dock-popover w-[368px] max-w-[calc(100vw-16px)] p-0"
        data-testid="promptdock-frame-popover"
      >
        <div className="mb-1 flex items-center justify-between gap-2 border-b border-border px-3.5 pb-2 pt-1.5">
          <span className="text-xs font-semibold text-muted-foreground">画幅</span>
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground tabular-nums">
            {chipText}
          </span>
        </div>
        {spec.kind === 'constrained' ? (
          <FrameConstrainedBody spec={spec} args={args} translate={translate} onChange={onChange} />
        ) : (
          <FrameComboBody spec={spec} args={args} translate={translate} onChange={onChange} />
        )}
      </PopoverContent>
    </Popover>
  );
}
