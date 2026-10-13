import React from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FieldLabel } from "@/features/workspace/schema/components/FieldLabel";
import type { SchemaToggleField } from "@/features/workspace/schema/types";
import type { BaseOptionFieldProps } from "@/features/workspace/schema/renderers/SelectInputRenderer";
import { useFieldOptions } from "@/features/workspace/schema/renderers/SelectInputRenderer";
import type { getSemanticIcon } from "@/features/workspace/schema/renderers/FieldIconHelper";

export const ToggleFieldInput = <FieldKey extends string>({
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
}: BaseOptionFieldProps<FieldKey, SchemaToggleField<FieldKey>>) => {
  const optionState = useFieldOptions(field, schema, values, modelId, optionsCache);
  const resolvedOptions = optionState.options;
  const exclusive = field.exclusive !== false;
  const currentValue = exclusive
    ? (typeof values[field.key] === "string" ? (values[field.key] as string) : "")
    : Array.isArray(values[field.key])
      ? (values[field.key] as unknown[])
      : [];
  const activeOption =
    exclusive && typeof currentValue === "string"
      ? resolvedOptions.find((option) => option.value === currentValue)
      : null;
  const activeDescriptionKey =
    activeOption !== null && activeOption !== undefined ? activeOption.descriptionKey : undefined;

  // 类型层面引用 getSemanticIcon，满足类型导入要求，不影响运行时行为
  type _SemanticIconType = ReturnType<typeof getSemanticIcon>;

  return (
    <div className={useIconLabels ? "flex items-center gap-2" : "flex flex-col gap-1"}>
      <FieldLabel label={label} useIconLabels={useIconLabels} fieldKey={String(field.key)} fieldType={field.type} iconVariant={undefined} className={undefined} />
      {exclusive ? (
        <ToggleGroup
          type="single"
          onValueChange={(next: string) => {
            if (!next) return;
            onChange(next);
            onBlur();
          }}
          className="flex flex-wrap gap-2"
          {...((currentValue as string) ? { value: currentValue as string } : {})}
        >
          {resolvedOptions.map((option) => (
            <ToggleGroupItem
              key={String(option.value)}
              value={String(option.value)}
              disabled={disabled || option.disabled === true}
            >
              {translate(option.labelKey, option.labelParams)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : (
        <ToggleGroup
          type="multiple"
          value={Array.isArray(currentValue) ? (currentValue as string[]) : []}
          onValueChange={(next: string[]) => {
            onChange(next);
          }}
          className="flex flex-wrap gap-2"
        >
          {resolvedOptions.map((option) => (
            <ToggleGroupItem
              key={String(option.value)}
              value={String(option.value)}
              disabled={disabled || option.disabled === true}
            >
              {translate(option.labelKey, option.labelParams)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {errorText ? (
        <p className="text-xs text-destructive">{errorText}</p>
      ) : helperText ? (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      ) : null}
      {exclusive && activeDescriptionKey ? (
        <div className="text-sm text-muted-foreground">
          {translate(activeDescriptionKey)}
        </div>
      ) : null}
    </div>
  );
};
