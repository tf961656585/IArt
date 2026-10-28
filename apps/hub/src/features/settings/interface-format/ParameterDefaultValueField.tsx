import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@iart/ui';
import {
  EnumDefaultSelect,
  NO_DEFAULT_OPTION,
  NumberValueInput,
} from '../components/ParameterValueControls';
import type { ParameterDefaultType } from './parameterDefaults';

/**
 * 接口格式参数行的「默认值」控件：按参数类型换控件，UI 侧统一用字符串持有原始值。
 *
 * 原始值形态：文本 = 任意文本；数字 = 用户输入的原文（合法性由 `parseDefaultValue` 判）；
 * 开关 = `'' | 'true' | 'false'`；选项 = 可选值原文。控件只负责收集原文，不在这里判合法性。
 */
export function ParameterDefaultValueField({
  type,
  value,
  enumValues,
  onChange,
  id,
  ariaLabel,
  invalid = false,
  describedBy,
}: {
  type: ParameterDefaultType;
  value: string;
  enumValues: string[];
  onChange: (raw: string) => void;
  id: string;
  ariaLabel: string;
  invalid?: boolean;
  describedBy?: string | undefined;
}) {
  if (type === 'string') {
    return (
      <Input
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (type === 'number') {
    return (
      <NumberValueInput
        id={id}
        rawValue={value}
        onRawChange={onChange}
        ariaLabel={ariaLabel}
        invalid={invalid}
        describedBy={describedBy}
        className="h-8"
      />
    );
  }

  if (type === 'boolean') {
    return (
      <Select
        value={
          value === 'true' ? 'true' : value === 'false' ? 'false' : NO_DEFAULT_OPTION
        }
        onValueChange={(next) => onChange(next === NO_DEFAULT_OPTION ? '' : next)}
      >
        <SelectTrigger
          id={id}
          size="sm"
          className="w-full"
          aria-label={ariaLabel}
          aria-invalid={invalid}
          aria-describedby={describedBy}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_DEFAULT_OPTION}>未设置</SelectItem>
          <SelectItem value="true">是</SelectItem>
          <SelectItem value="false">否</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  return (
    <EnumDefaultSelect
      id={id}
      options={enumValues}
      value={value === '' ? undefined : value}
      onChange={(next) => onChange(next === undefined ? '' : String(next))}
      ariaLabel={ariaLabel}
      noDefaultLabel="未设置"
      placeholder="先填可选值"
      disabled={enumValues.length === 0}
      invalid={invalid}
      describedBy={describedBy}
      triggerClassName="w-full"
    />
  );
}
