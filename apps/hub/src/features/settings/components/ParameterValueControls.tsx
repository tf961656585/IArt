import { useEffect, useState } from 'react';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from '@iart/ui';

/**
 * 参数值编辑的共享叶子控件（服务商「参数覆盖」与接口格式「参数表」共用）。
 *
 * 两处都在做「按类型给默认值换控件」，只是文案与外壳不同；控件本身（可选值芯片列表、
 * 枚举默认值下拉、数字输入）只有一份实现，避免同一份「类型 → 控件」映射写两遍后漂移。
 * 文案与状态（`noDefaultLabel` / `placeholder` / `disabled`）由调用方传，控件不预设业务口径。
 */

/** 参数值的可表达标量域（与共享契约的默认值值域一致）。 */
export type ParameterValue = string | number | boolean;

/** 「不设默认值」在 Radix Select 里的哨兵值；Radix 不允许空字符串作为 item 值。 */
export const NO_DEFAULT_OPTION = '__no_default__';

/** 两个合法值是否同一个值（值域是三种标量，严格相等即可）。 */
export const sameValue = (a: ParameterValue, b: ParameterValue): boolean => a === b;

/** 合法值在 Radix Select 里的键（三种标量都可能有，前缀避免 `1` 与 `"1"` 混淆）。 */
export const valueKey = (value: ParameterValue): string =>
  typeof value === 'string'
    ? `s:${value}`
    : typeof value === 'number'
      ? `n:${value}`
      : `b:${value}`;

/**
 * 枚举/可选值的标签列表编辑：普通输入 + 标签删除钮（Radix Select 弹层里不放动作按钮）。
 *
 * 泛型只用于保留调用方的值域：服务商页用 `string | number | boolean`，接口格式页只用 `string[]`。
 * 新增值始终是输入框里的字符串，交给调用方的类型约束收窄。
 */
export function OptionListEditor<T extends ParameterValue>({
  options,
  onChange,
  addInputAriaLabel,
  addButtonAriaLabel,
  removeButtonAriaPrefix,
  inputId,
  invalid = false,
  describedBy,
}: {
  options: T[];
  onChange: (next: T[]) => void;
  addInputAriaLabel: string;
  addButtonAriaLabel: string;
  removeButtonAriaPrefix: string;
  /** 新增值输入框的稳定 id（供定位与无障碍关联）。 */
  inputId?: string;
  invalid?: boolean;
  describedBy?: string | undefined;
}) {
  const [draft, setDraft] = useState('');
  const add = (): void => {
    const value = draft.trim();
    if (value === '' || options.some((option) => sameValue(option, value))) return;
    onChange([...options, value as T]);
    setDraft('');
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.map((option) => (
        <span
          key={valueKey(option)}
          className="flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-2xs"
        >
          {String(option)}
          {/* 芯片组成件的移除钮（按钮样式标准 §7 出路①）：视觉语义由芯片整体承载，
              芯片内放不下任何尺寸档——不走共享 Button */}
          <button
            type="button"
            aria-label={`${removeButtonAriaPrefix}「${String(option)}」`}
            className="rounded-sm text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            onClick={() => onChange(options.filter((item) => !sameValue(item, option)))}
          >
            ×
          </button>
        </span>
      ))}
      <Input
        id={inputId}
        aria-label={addInputAriaLabel}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className="h-7 w-28 text-2xs"
        value={draft}
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            add();
          }
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="2xs"
        disabled={draft.trim() === ''}
        aria-label={addButtonAriaLabel}
        onClick={add}
      >
        添加
      </Button>
    </div>
  );
}

/**
 * 枚举默认值下拉：第一项是「不设默认值」，其余来自候选值。
 *
 * `noDefaultLabel` 由调用方给（服务商页「保持默认」/ 接口格式页「未设置」）；候选值为空时
 * 用 `placeholder` 说明先填什么，与 `disabled` 一起把「还没可选」讲清楚。
 */
export function EnumDefaultSelect({
  options,
  value,
  ariaLabel,
  onChange,
  noDefaultLabel = '未设置',
  placeholder,
  disabled = false,
  invalid = false,
  id,
  describedBy,
  triggerClassName = 'w-44',
}: {
  options: ParameterValue[];
  value: ParameterValue | undefined;
  ariaLabel: string;
  onChange: (next: ParameterValue | undefined) => void;
  noDefaultLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  describedBy?: string | undefined;
  /** 触发器宽度由外壳决定（固定宽字段要 `w-full`）。 */
  triggerClassName?: string;
}) {
  const decode = new Map(options.map((option) => [valueKey(option), option]));
  const inOptions = value !== undefined && options.some((option) => sameValue(option, value));
  // 没有候选值且调用方给了占位文案时才切到未选中态（接口格式要说明「先填可选值」）；
  // 其余调用点（服务商页）保持「不设默认值」这一项可见，行为与抽取前一致。
  const showPlaceholder = options.length === 0 && placeholder !== undefined;

  return (
    <Select
      value={showPlaceholder ? '' : inOptions && value !== undefined ? valueKey(value) : NO_DEFAULT_OPTION}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === NO_DEFAULT_OPTION) {
          onChange(undefined);
          return;
        }
        const decoded = decode.get(next);
        if (decoded !== undefined) onChange(decoded);
      }}
    >
      <SelectTrigger
        id={id}
        size="sm"
        className={triggerClassName}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        aria-describedby={describedBy}
      >
        <SelectValue placeholder={showPlaceholder ? placeholder : undefined} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_DEFAULT_OPTION}>{noDefaultLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={valueKey(option)} value={valueKey(option)}>
            {String(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * 数字默认值输入，两种持有模式共用同一个渲染：
 *
 * - 数字模式（`value` + `onCommit`）：能解析成数字就即时写入，解析不了只留在输入框里
 *   （不进数据、不拦提交）——服务商「参数覆盖」用它。
 * - 原始输入模式（`rawValue` + `onRawChange`）：输入过程完全由父层持有原始字符串，
 *   父层据此判断非法并拦住保存——接口格式「参数表」用它。
 */
export function NumberValueInput({
  value,
  onCommit,
  rawValue,
  onRawChange,
  ariaLabel,
  invalid = false,
  id,
  className,
  describedBy,
}: {
  /** 数字模式当前值（未设置为 `undefined`）。 */
  value?: number | undefined;
  /** 数字模式提交回调：空输入提交 `undefined`。 */
  onCommit?: (next: number | undefined) => void;
  /** 原始输入模式：父层持有的原文。 */
  rawValue?: string;
  /** 原始输入模式：每次输入把原文交回父层。 */
  onRawChange?: (raw: string) => void;
  ariaLabel: string;
  invalid?: boolean;
  id?: string;
  className?: string;
  describedBy?: string | undefined;
}) {
  const rawMode = rawValue !== undefined;
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));

  useEffect(() => {
    if (!rawMode) setDraft(value === undefined ? '' : String(value));
  }, [rawMode, value]);

  const current = rawMode ? rawValue : draft;

  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      aria-invalid={rawMode ? invalid : undefined}
      aria-describedby={describedBy}
      className={cn('h-7 flex-1 text-xs', className)}
      value={current}
      inputMode="decimal"
      autoComplete="off"
      onChange={(event) => {
        const raw = event.target.value;
        if (rawMode) {
          onRawChange?.(raw);
          return;
        }
        setDraft(raw);
        const trimmed = raw.trim();
        if (trimmed === '') {
          onCommit?.(undefined);
          return;
        }
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) onCommit?.(parsed);
      }}
    />
  );
}
