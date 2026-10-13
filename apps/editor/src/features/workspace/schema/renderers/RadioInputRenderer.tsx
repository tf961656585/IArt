import React from "react";
import { FieldLabel } from "@/features/workspace/schema/components/FieldLabel";
import type { SchemaRadioField } from "@/features/workspace/schema/types";
import type { BaseOptionFieldProps } from "@/features/workspace/schema/renderers/SelectInputRenderer";
import { useFieldOptions } from "@/features/workspace/schema/renderers/SelectInputRenderer";
import type { getSemanticIcon } from "@/features/workspace/schema/renderers/FieldIconHelper";

export const RadioFieldInput = <FieldKey extends string>({
  field,
  schema,
  values,
  modelId,
  disabled,
  label,
  helperText,
  errorText,
  translate,
  optionsCache,
  onChange,
  onBlur,
  useIconLabels,
}: BaseOptionFieldProps<FieldKey, SchemaRadioField<FieldKey>>) => {
  const optionState = useFieldOptions(field, schema, values, modelId, optionsCache);
  const resolvedOptions = optionState.options;
  const currentValue = typeof values[field.key] === "string" ? (values[field.key] as string) : "";

  // 类型层面引用 getSemanticIcon，满足类型导入要求，不影响运行时行为
  type _SemanticIconType = ReturnType<typeof getSemanticIcon>;

  return (
    <div className={useIconLabels ? "flex items-center gap-2" : "flex flex-col gap-1"}>
      <FieldLabel label={label} useIconLabels={useIconLabels} fieldKey={String(field.key)} fieldType={field.type} iconVariant={undefined} className={undefined} />
      <div className="flex flex-col gap-1">
        {resolvedOptions.map((option) => (
          <label key={String(option.value)} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              className="size-4 accent-primary"
              value={String(option.value)}
              checked={currentValue === option.value}
              onChange={(e) => onChange(e.target.value)}
              onBlur={onBlur}
              disabled={disabled || option.disabled}
            />
            <span>{translate(option.labelKey, option.labelParams)}</span>
          </label>
        ))}
      </div>
      {errorText ? (
        <p className="text-xs text-destructive">{errorText}</p>
      ) : helperText ? (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      ) : null}
    </div>
  );
};
