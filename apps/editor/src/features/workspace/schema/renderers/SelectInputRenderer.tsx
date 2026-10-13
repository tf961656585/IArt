import React, { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldLabel } from "@/features/workspace/schema/components/FieldLabel";
import { evaluateCondition } from "@/features/workspace/schema/helpers";
import type {
  SchemaCondition,
  SchemaFieldOption,
  SchemaFormDefinition,
  SchemaFormValues,
  SchemaSelectField,
  SchemaRadioField,
  SchemaToggleField,
  SchemaTranslate,
} from "@/features/workspace/schema/types";

type FieldWithOptions<FieldKey extends string> =
  | SchemaSelectField<FieldKey>
  | SchemaRadioField<FieldKey>
  | SchemaToggleField<FieldKey>;

export interface BaseOptionFieldProps<FieldKey extends string, FieldType extends FieldWithOptions<FieldKey>> {
  field: FieldType;
  schema: SchemaFormDefinition<FieldKey>;
  values: SchemaFormValues<FieldKey>;
  modelId: string;
  disabled: boolean;
  label: string;
  helperText: string;
  errorText: string | null;
  placeholder: string | undefined;
  translate: SchemaTranslate;
  optionsCache: React.MutableRefObject<Map<string, SchemaFieldOption[]>>;
  onChange: (value: unknown) => void;
  onBlur: () => void;
  useIconLabels: boolean | undefined;
}

interface UseFieldOptionsResult {
  options: ResolvedSchemaFieldOption[];
  loading: boolean;
}

type ResolvedSchemaFieldOption = SchemaFieldOption & { disabled: boolean | undefined };

const resolveOptionDefaults = (option: SchemaFieldOption): ResolvedSchemaFieldOption => ({
  ...option,
  disabled: undefined,
});

const resolveOptionDefaultsList = (options: SchemaFieldOption[]): ResolvedSchemaFieldOption[] =>
  options.map(resolveOptionDefaults);

export const useFieldOptions = <FieldKey extends string>(
  field: FieldWithOptions<FieldKey>,
  schema: SchemaFormDefinition<FieldKey>,
  values: SchemaFormValues<FieldKey>,
  modelId: string,
  cacheRef: React.MutableRefObject<Map<string, SchemaFieldOption[]>>
): UseFieldOptionsResult => {
  const optionsSource = field.options;
  const [state, setState] = useState<UseFieldOptionsResult>({
    options: optionsSource.kind === "static" ? resolveOptionDefaultsList(optionsSource.options) : [],
    loading: optionsSource.kind === "async",
  });

  useEffect(() => {
    if (optionsSource.kind !== "static") {
      return;
    }
    // 对于静态选项，仅在 optionsSource 指针变化时同步一次，避免与下方 resolveDisabled
    // effect 之间互相触发 setState，造成无限更新。
    setState((prev) => {
      const nextOptions = resolveOptionDefaultsList(optionsSource.options);
      if (prev.options === nextOptions && prev.loading === false) {
        return prev;
      }
      return { options: nextOptions, loading: false };
    });
  }, [optionsSource]);

  useEffect(() => {
    if (optionsSource.kind === "static") {
      // 静态选项已在上方 effect 中处理，这里只负责异步加载场景。
      return;
    }
    let cancelled = false;
    const cacheKey = optionsSource.cacheKey ?? field.key;
    const cached = cacheRef.current.get(cacheKey);
    if (cached && optionsSource.once !== false) {
      setState({ options: resolveOptionDefaultsList(cached), loading: false });
      return;
    }
    setState((prev) => ({ ...prev, loading: true }));
	    const shallowEqual = (a: SchemaFieldOption[], b: SchemaFieldOption[]) => {
	      if (a === b) return true;
	      if (a.length !== b.length) return false;
	      for (let i = 0; i < a.length; i++) {
	        const x = a[i];
	        const y = b[i];
	        if (!x || !y) {
	          return false;
	        }
        if (
          x.value !== y.value ||
          x.labelKey !== y.labelKey ||
          x.descriptionKey !== y.descriptionKey
        ) {
          return false;
        }
      }
      return true;
    };

    const load = async () => {
      try {
        const result = await optionsSource.loader({
          field: field.key,
          schema,
          values,
          modelId,
          locale: undefined,
        });
        if (cancelled) return;
        // 避免相同结果反复 setState 触发重渲染
        const prevOpts = state.options;
        cacheRef.current.set(cacheKey, result);
        const nextOptions = resolveOptionDefaultsList(result);
        if (!shallowEqual(prevOpts, nextOptions)) {
          setState({ options: nextOptions, loading: false });
        } else {
          setState((prev) => (prev.loading ? { ...prev, loading: false } : prev));
        }
      } catch (err) {
        console.error("failed to load schema async options", err);
        if (cancelled) return;
        setState((prev) => ({ ...prev, loading: false }));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [optionsSource, field.key, schema, values, modelId, cacheRef, state.options]);

  useEffect(() => {
    let cancelled = false;
    const resolveDisabled = async () => {
      if (!state.options.some((option) => option.disabledWhen)) {
        return;
      }
      const resolved = await Promise.all(
        state.options.map(async (option) => {
          if (!option.disabledWhen) return option;
          const disabled = await evaluateCondition(option.disabledWhen as SchemaCondition<FieldKey>, {
            schema,
            values,
            modelId,
            field: field.key,
          });
          return { ...option, disabled };
        })
      );
      if (cancelled) return;
      const hasDiff = resolved.some((option, index) => option.disabled !== (state.options[index] !== null && state.options[index] !== undefined ? state.options[index].disabled : undefined));
      if (!hasDiff) return;
      setState((prev) => ({ ...prev, options: resolved }));
    };
    void resolveDisabled();
    return () => {
      cancelled = true;
    };
  }, [state.options, schema, values, modelId, field.key]);

  return state;
};

export const translateOptionLabel = (
  options: SchemaFieldOption[],
  value: unknown,
  translate: SchemaTranslate
): string => {
  const found = options.find((option) => option.value === value);
  if (!found) return String(value ?? "");
  return translate(found.labelKey, found.labelParams);
};

export const SelectFieldInput = <FieldKey extends string>({
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
}: BaseOptionFieldProps<FieldKey, SchemaSelectField<FieldKey>>) => {
	  const optionState = useFieldOptions(field, schema, values, modelId, optionsCache);
	  const resolvedOptions = optionState.options;
	  const multiple = Boolean(field.multiple);
	  const canClearSingle = !multiple && field.clearable === true;
	  const rawValue = values[field.key];
	  const currentValue = useMemo<(string | number)[] | string | number>(
	    () =>
	      multiple
	        ? Array.isArray(rawValue)
	          ? rawValue.filter((item): item is string | number => typeof item === "string" || typeof item === "number")
	          : []
	        : typeof rawValue === "string" || typeof rawValue === "number"
	          ? rawValue
	          : "",
	    [multiple, rawValue]
	  );

  const optionValues = useMemo(
    () => new Set(resolvedOptions.map((opt) => opt.value as string | number)),
    [resolvedOptions]
  );

  useEffect(() => {
    if (optionState.loading) return;
    if (!multiple) {
      if (typeof currentValue === "string" || typeof currentValue === "number") {
        if (canClearSingle && currentValue === "") {
          return;
        }
        if (!optionValues.has(currentValue)) {
          const defaultCandidate = field.defaultValue as string | number | undefined;
          const nextValue =
            defaultCandidate !== undefined && optionValues.has(defaultCandidate)
              ? defaultCandidate
              : canClearSingle
                ? ""
                : ((resolvedOptions[0] !== null && resolvedOptions[0] !== undefined ? resolvedOptions[0].value : undefined) as string | number | undefined) ?? "";
          if (nextValue !== currentValue) onChange(nextValue);
        }
      }
    } else {
      const list = Array.isArray(currentValue) ? (currentValue as (string | number)[]) : [];
      const filtered = list.filter((v) => optionValues.has(v));
      if (filtered.length !== list.length) onChange(filtered);
    }
  }, [optionState.loading, multiple, currentValue, optionValues, resolvedOptions, field.defaultValue, canClearSingle, onChange]);

  return (
    <div className={useIconLabels ? "flex items-center gap-2" : "flex flex-col gap-1"}>
      <FieldLabel label={label} useIconLabels={useIconLabels} fieldKey={String(field.key)} fieldType={field.type} iconVariant={undefined} className={undefined} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" className="justify-between" disabled={disabled}>
            {multiple
              ? (currentValue as (string | number)[])
                  .map((v) => translateOptionLabel(resolvedOptions, v, translate))
                  .join(" / ") || translate("common:select", "请选择")
              : translateOptionLabel(resolvedOptions, currentValue, translate) ||
                translate("common:select", "请选择")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-[260px]">
          {multiple ? (
            resolvedOptions.map((option) => {
              const selected = (currentValue as (string | number)[]).includes(
                option.value as string | number
              );
              return (
                <DropdownMenuCheckboxItem
                  key={String(option.value)}
                  checked={selected}
                  {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
                  onCheckedChange={(checked) => {
                    const list = Array.isArray(currentValue)
                      ? ([...currentValue] as (string | number)[])
                      : [];
                    const val = option.value as string | number;
                    const next = checked
                      ? Array.from(new Set([...list, val]))
                      : list.filter((v) => v !== val);
                    onChange(next);
                  }}
                >
                  <div className="flex flex-col">
                    <span className="text-sm">
                      {translate(option.labelKey, option.labelParams)}
                    </span>
                    {option.descriptionKey ? (
                      <span className="text-xs text-muted-foreground">
                        {translate(option.descriptionKey)}
                      </span>
                    ) : null}
                  </div>
                </DropdownMenuCheckboxItem>
              );
            })
          ) : (
            <>
              {canClearSingle ? (
                <>
                  <DropdownMenuItem
                    disabled={currentValue === ""}
                    onSelect={() => {
                      onChange("");
                      onBlur();
                    }}
                  >
                    {translate("common:actions.clear", "清除")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuRadioGroup
                value={typeof currentValue === "string" || typeof currentValue === "number" ? String(currentValue) : ""}
                onValueChange={(v) => {
                  const nextOpt = resolvedOptions.find((o) => String(o.value) === v);
                  onChange((nextOpt !== null && nextOpt !== undefined ? nextOpt.value : undefined) ?? "");
                  onBlur();
                }}
              >
                {resolvedOptions.map((option) => (
                  <DropdownMenuRadioItem
                    key={String(option.value)}
                    value={String(option.value)}
                    {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
                  >
                    <div className="flex flex-col">
                      <span className="text-sm">
                        {translate(option.labelKey, option.labelParams)}
                      </span>
                      {option.descriptionKey ? (
                        <span className="text-xs text-muted-foreground">
                          {translate(option.descriptionKey)}
                        </span>
                      ) : null}
                    </div>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {errorText ? (
        <p className="text-xs text-destructive">{errorText}</p>
      ) : helperText ? (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      ) : null}
    </div>
  );
};
