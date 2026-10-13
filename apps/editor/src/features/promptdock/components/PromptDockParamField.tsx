'use client';

import { useMemo } from 'react';

import type { ExecutableCatalogParameterField } from '@iart/contracts';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { ParamTranslate } from '../promptDockParamModel';
import {
  buildImageSizeChoices,
  buildSelectOptions,
  resolveParamLabel,
} from '../promptDockParamModel';

/**
 * PromptDock 参数控件（inline 层与完整参数面板共用，spec 节点参数呈现分层.md
 * 「同一参数在两层的条件显隐判据一致」——共用渲染路径即天然一致）。
 *
 * 覆盖可执行目录四类族的字段词汇表：select / imageSize（constrainedResolution 派生为
 * 档位×比例枚举）/ switch / text、number。媒体上传字段不呈现（参考区唯一承载）。
 */

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : null;

type ParamFieldControlProps = {
  field: ExecutableCatalogParameterField;
  value: unknown;
  onValueChange: (next: unknown) => void;
  translate: ParamTranslate;
  /** compact=inline 参数行小控件；sheet=完整面板行内控件 */
  variant: 'compact' | 'sheet';
  disabled?: boolean | undefined;
};

export function ParamFieldControl({
  field,
  value,
  onValueChange,
  translate,
  variant,
  disabled = false,
}: ParamFieldControlProps) {
  const label = useMemo(
    () => resolveParamLabel(translate, field.label, field.fieldKey),
    [translate, field.label, field.fieldKey],
  );

  const component = field.component.toLowerCase();

  // imageSize：constrainedResolution 属性 → 扁平枚举（auto/比例×分辨率档）。
  // 派生失败（形态不符）时不呈现——AGENTS.md「条件跳过必须留痕」由调用方容器处理。
  if (component === 'imagesize') {
    const sizeChoices = buildImageSizeChoices(field, translate);
    if (sizeChoices === null) return null;
    return (
      <ParamSelectControl
        label={label}
        value={value}
        options={sizeChoices.map((choice) => ({ value: choice.value, label: choice.label }))}
        onValueChange={onValueChange}
        variant={variant}
        disabled={disabled}
      />
    );
  }

  if (component === 'switch' || component === 'toggle') {
    const checked = value === true || value === 'true' || value === 1;
    const control = (
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onValueChange(next)}
        aria-label={label}
      />
    );
    if (variant === 'compact') {
      return (
        <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background/40 px-2">
          <span className="text-[11px] whitespace-nowrap text-muted-foreground">{label}</span>
          {control}
        </span>
      );
    }
    return control;
  }

  if (component === 'number') {
    const numeric = asNumber(value);
    return (
      <Input
        type="number"
        value={numeric === null ? '' : String(numeric)}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          onValueChange(next === '' ? null : Number(next));
        }}
        aria-label={label}
        className={
          variant === 'compact'
            ? 'h-7 w-24 rounded-lg border-border bg-background/40 text-[11px]'
            : undefined
        }
      />
    );
  }

  const options = buildSelectOptions(field, translate);
  if (options.length > 0) {
    return (
      <ParamSelectControl
        label={label}
        value={value}
        options={options}
        onValueChange={onValueChange}
        variant={variant}
        disabled={disabled}
      />
    );
  }

  // text / 其他无枚举形态 → 文本输入
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  return (
    <Input
      value={text}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
      placeholder={label}
      aria-label={label}
      className={
        variant === 'compact'
          ? 'h-7 w-32 rounded-lg border-border bg-background/40 text-[11px]'
          : undefined
      }
    />
  );
}

function ParamSelectControl({
  label,
  value,
  options,
  onValueChange,
  variant,
  disabled,
}: {
  label: string;
  value: unknown;
  options: { value: string; label: string }[];
  onValueChange: (next: unknown) => void;
  variant: 'compact' | 'sheet';
  disabled: boolean;
}) {
  const stringValue =
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  return (
    <Select value={stringValue} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        size="sm"
        className={
          variant === 'compact'
            ? 'h-7 max-w-[220px] gap-1.5 rounded-lg border-border bg-background/40 px-2 text-[11px] whitespace-nowrap'
            : 'w-full'
        }
        aria-label={label}
      >
        <SelectValue placeholder={label} />
      </SelectTrigger>
      {/* 同 Dock 弹层口径：向上弹、左缘对齐、z 高于 Dock 卡片 z-dock */}
      <SelectContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="z-dock-popover max-h-[280px]"
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
