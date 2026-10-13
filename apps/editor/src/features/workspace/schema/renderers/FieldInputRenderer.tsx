import React from "react";

import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ImageSizeSelector } from "@/client/components/ImageSizeSelector";
import { FieldLabel } from "@/features/workspace/schema/components/FieldLabel";
import type { getSemanticIcon } from "@/features/workspace/schema/renderers/FieldIconHelper";
import {
  getStructuredLinePairEditorMetadata,
  resolveStructuredLinePairRightOptions,
  StructuredLinePairEditor,
} from "@/features/workspace/schema/components/StructuredLinePairEditor";
import type {
  SchemaDataFieldDefinition,
  SchemaFieldOption,
  SchemaFormDefinition,
  SchemaFormValues,
  SchemaSelectField,
  SchemaRadioField,
  SchemaToggleField,
  SchemaTranslate,
} from "@/features/workspace/schema/types";
import { SelectFieldInput } from "@/features/workspace/schema/renderers/SelectInputRenderer";
import { RadioFieldInput } from "@/features/workspace/schema/renderers/RadioInputRenderer";
import { ToggleFieldInput } from "@/features/workspace/schema/renderers/ToggleInputRenderer";
import { FileUploadInput } from "@/features/workspace/schema/renderers/FileUploadInputRenderer";

interface FieldInputProps<FieldKey extends string> {
  field: SchemaDataFieldDefinition<FieldKey>;
  schema: SchemaFormDefinition<FieldKey>;
  values: SchemaFormValues<FieldKey>;
  modelId: string;
  disabled: boolean;
  errorMessage: string | null;
  touched: boolean;
  translate: SchemaTranslate;
  optionsCache: React.MutableRefObject<Map<string, SchemaFieldOption[]>>;
  onChange: (value: unknown) => void;
  onBlur: () => void;
  onPatchValues: (patch: Partial<SchemaFormValues<FieldKey>>) => void | undefined;
  useIconLabels: boolean | undefined;
  /** 紧凑模式 - 用于 Dock 场景 */
  compact: boolean | undefined;
}

type _SemanticIconType = ReturnType<typeof getSemanticIcon>;

const FieldInput = <FieldKey extends string,>({
  field,
  schema,
  values,
  modelId,
  disabled,
  errorMessage,
  touched,
  translate,
  optionsCache,
  onChange,
  onBlur,
  onPatchValues,
  useIconLabels,
  compact = false,
}: FieldInputProps<FieldKey>) => {
  const iconLabels = Boolean(useIconLabels);
  const value = values[field.key];
  const label = translate(field.labelKey, undefined);
  const placeholder = translate(field.placeholderKey, undefined);
  const helper = translate(field.helperTextKey, field.helperTextParams);
  const displayErrorKey = touched ? errorMessage : null;
  const displayErrorText = displayErrorKey ? translate(displayErrorKey, displayErrorKey) : null;
  const helperText = displayErrorText ?? helper;
  const structuredLinePairMetadata = getStructuredLinePairEditorMetadata(field.metadata);

  if (field.type === "text" || field.type === "textarea" || field.type === "number") {
    const numeric = field.type === "number";
    const inputValue =
      numeric && typeof value === "number"
        ? value
        : typeof value === "string"
          ? value
          : numeric
            ? ""
            : "";
    const isPrimaryPrompt = ((schema.prompt !== null && schema.prompt !== undefined ? schema.prompt.primaryField : undefined) as FieldKey | undefined) === field.key;
    const suppressPromptRequiredText =
      isPrimaryPrompt && displayErrorKey === "pages:modelWorkspace.form.validation.required";
    const effectiveErrorText = suppressPromptRequiredText ? null : displayErrorText;
    const effectiveHelperText = effectiveErrorText ?? helper;
    return (
      <div className={iconLabels ? "flex items-center gap-2" : "flex flex-col gap-1"}>
        <FieldLabel label={label} useIconLabels={iconLabels} fieldKey={String(field.key)} fieldType={field.type} iconVariant={undefined} className={undefined} />
        {field.type === "textarea" && structuredLinePairMetadata ? (
          <StructuredLinePairEditor
            value={value}
            disabled={disabled}
            separator={structuredLinePairMetadata.separator}
            leftLabel={translate(structuredLinePairMetadata.leftLabelKey, { defaultValue: "角色名" })}
            rightLabel={translate(structuredLinePairMetadata.rightLabelKey, { defaultValue: "声音名" })}
            leftPlaceholder={translate(structuredLinePairMetadata.leftPlaceholderKey, { defaultValue: "" })}
            rightPlaceholder={translate(structuredLinePairMetadata.rightPlaceholderKey, { defaultValue: "" })}
            addButtonLabel={translate(structuredLinePairMetadata.addButtonLabelKey, { defaultValue: "新增角色" })}
            removeButtonLabel={translate(
              structuredLinePairMetadata.removeButtonLabelKey,
              { defaultValue: "删除" }
            )}
            rightOptions={resolveStructuredLinePairRightOptions(
              schema,
              structuredLinePairMetadata.voiceFieldKey,
              (option) => translate(option.labelKey, { defaultValue: String(option.value) })
            )}
            onChange={(next) => onChange(next)}
          />
        ) : field.type === "textarea" ? (
          <Textarea
            className="focus-visible:border-input focus-visible:ring-0 focus-visible:ring-transparent"
            placeholder={placeholder}
            value={typeof inputValue === "string" ? inputValue : String(inputValue ?? "")}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            disabled={disabled}
            rows={field.minRows ?? 4}
          />
        ) : (
          <Input
            className="focus-visible:border-input focus-visible:ring-0 focus-visible:ring-transparent"
            type={numeric ? "number" : "text"}
            placeholder={placeholder}
            value={typeof inputValue === "string" ? inputValue : String(inputValue ?? "")}
            onChange={(e) => {
              if (numeric) {
                const next = e.target.value;
                onChange(next === "" ? "" : Number(next));
              } else {
                onChange(e.target.value);
              }
            }}
            onBlur={onBlur}
            disabled={disabled}
          />
        )}
        {effectiveErrorText ? (
          <p className="text-xs text-destructive">{effectiveErrorText}</p>
        ) : effectiveHelperText ? (
          <p className="text-xs text-muted-foreground">{effectiveHelperText}</p>
        ) : null}
        {numeric && field.unitKey ? (
          <p className="text-[11px] text-muted-foreground">{translate(field.unitKey, undefined)}</p>
        ) : null}
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <SelectFieldInput
        field={field as SchemaSelectField<FieldKey>}
        schema={schema}
        values={values}
        modelId={modelId}
        disabled={disabled}
        label={label}
        helperText={helperText}
        errorText={displayErrorText}
        placeholder={placeholder}
        translate={translate}
        optionsCache={optionsCache}
        onChange={onChange}
        onBlur={onBlur}
        useIconLabels={iconLabels}
      />
    );
  }

  if (field.type === "radio") {
    return (
      <RadioFieldInput
        field={field as SchemaRadioField<FieldKey>}
        schema={schema}
        values={values}
        modelId={modelId}
        disabled={disabled}
        label={label}
        helperText={helperText}
        errorText={displayErrorText}
        placeholder={placeholder}
        translate={translate}
        optionsCache={optionsCache}
        onChange={onChange}
        onBlur={onBlur}
        useIconLabels={iconLabels}
      />
    );
  }

  if (field.type === "toggle") {
    return (
      <ToggleFieldInput
        field={field as SchemaToggleField<FieldKey>}
        schema={schema}
        values={values}
        modelId={modelId}
        disabled={disabled}
        label={label}
        helperText={helperText}
        errorText={displayErrorText}
        placeholder={placeholder}
        translate={translate}
        optionsCache={optionsCache}
        onChange={onChange}
        onBlur={onBlur}
        useIconLabels={iconLabels}
      />
    );
  }

  if (field.type === "switch") {
    const checked = typeof value === "boolean" ? value : Boolean(field.defaultValue);
    return (
      <div className="flex items-center gap-2">
        <FieldLabel label={label} useIconLabels={iconLabels} fieldKey={String(field.key)} fieldType={field.type} iconVariant={undefined} className={undefined} />
        <Switch checked={checked} onCheckedChange={(next) => onChange(next)} disabled={disabled} />
        {helperText ? (
          <span className="flex-1 text-right text-xs text-muted-foreground">
            {helperText}
          </span>
        ) : null}
      </div>
    );
  }

  if (field.type === "tags") {
    const list = Array.isArray(value) ? (value as string[]) : [];
    const display = list.join(", ");
    return (
      <div className={iconLabels ? "flex items-center gap-2" : "flex flex-col gap-1"}>
        <FieldLabel label={label} useIconLabels={iconLabels} fieldKey={String(field.key)} fieldType={field.type} iconVariant={undefined} className={undefined} />
        <Input
          className="focus-visible:border-input focus-visible:ring-0 focus-visible:ring-transparent"
          placeholder={placeholder}
          value={display}
          onChange={(e) => {
            const raw = e.target.value as string;
            const next = raw
              .split(/[,\n]/)
              .map((s) => s.trim())
              .filter(Boolean);
            onChange(next);
          }}
          onBlur={onBlur}
          disabled={disabled}
        />
        {displayErrorText ? (
          <p className="text-xs text-destructive">{displayErrorText}</p>
        ) : helperText ? (
          <p className="text-xs text-muted-foreground">{helperText}</p>
        ) : null}
      </div>
    );
  }

  if (field.type === "slider") {
    const sliderValue = typeof value === "number" ? value : field.min;
    return (
      <div className={iconLabels ? "flex items-center gap-2" : "flex flex-col gap-1"}>
        <FieldLabel label={label} useIconLabels={iconLabels} fieldKey={String(field.key)} fieldType={field.type} iconVariant={undefined} className={undefined} />
        <Slider
          value={[sliderValue]}
          min={field.min}
          max={field.max}
          {...(field.step !== undefined ? { step: field.step } : {})}
          onValueChange={(vals) => onChange(vals[0] ?? sliderValue)}
          onPointerUp={onBlur}
          disabled={disabled}
        />
        {displayErrorText ? (
          <p className="text-xs text-destructive">{displayErrorText}</p>
        ) : null}
      </div>
    );
  }

  if (field.type === "imageSize") {
    const currentValue =
      typeof value === "string"
        ? value
        : typeof field.defaultValue === "string"
          ? (field.defaultValue as string)
          : "";
    const resolvedSizeOptions = field.sizeOptions ? field.sizeOptions.map((option) => ({
      label: option.labelKey ? translate(option.labelKey, undefined) : option.label ?? `${option.value}px`,
      value: option.value,
    })) : undefined;
    const aspectFieldKey = field.aspectField;
    const aspectValue =
      aspectFieldKey && typeof values[aspectFieldKey] === "string"
        ? (values[aspectFieldKey] as string)
        : undefined;
    const resolvedAspectOptions = field.aspectOptions ? field.aspectOptions.map((option, index) => ({
      id: option.id ?? option.value ?? `aspect-${index}`,
      label: option.labelKey ? translate(option.labelKey, undefined) : option.label ?? "",
      value: option.value,
      ratio: option.ratio,
      description: option.descriptionKey
        ? translate(option.descriptionKey, undefined)
        : option.description !== undefined
          ? option.description
          : undefined,
      resolution: option.resolution,
    })) : undefined;
    const resolvedPresetOptions = field.presetOptions ? field.presetOptions.map((option) => ({
      value: option.value,
      label: option.labelKey ? translate(option.labelKey, undefined) : option.label ?? option.value,
      description: option.descriptionKey
        ? translate(option.descriptionKey, undefined)
        : option.description !== undefined
          ? option.description
          : undefined,
    })) : undefined;
    const resolvedSizeLevels = field.sizeLevels ? field.sizeLevels.map((option) => ({
      id: option.id,
      label: option.labelKey ? translate(option.labelKey, undefined) : option.label ?? option.id,
      pixelBudget: option.pixelBudget,
    })) : undefined;
    const resolvedAspectPresets = field.aspectPresets ? field.aspectPresets.map((option) => ({
      id: option.id,
      label: option.labelKey ? translate(option.labelKey, undefined) : option.label ?? option.id,
      ratio: option.ratio,
    })) : undefined;
    const handleAspectValueChange = (nextAspect: string | undefined, nextResolution: string | undefined) => {
      if (!aspectFieldKey || !onPatchValues) {
        return undefined;
      }
      const patch: Partial<SchemaFormValues<FieldKey>> = {};
      if (nextAspect !== undefined) {
        patch[aspectFieldKey] = nextAspect;
      }
      if (nextResolution && nextResolution !== values[field.key]) {
        patch[field.key] = nextResolution;
      }
      if (Object.keys(patch).length > 0) {
        onPatchValues(patch);
      }
      return undefined;
    };
    return (
      <div className={iconLabels ? "flex items-center gap-2" : "flex flex-col gap-1"}>
        {iconLabels && (
          <FieldLabel label={label} useIconLabels={iconLabels} fieldKey={String(field.key)} fieldType={field.type} iconVariant={undefined} className={undefined} />
        )}
        <ImageSizeSelector
          value={currentValue}
          label={(!iconLabels && !compact) ? label : undefined}
          variant={(iconLabels || compact) ? "compact" : "default"}
          mode={field.mode}
          options={resolvedSizeOptions}
          aspectValue={aspectValue}
          onAspectValueChange={handleAspectValueChange}
          aspectOptions={resolvedAspectOptions}
          allowAuto={field.allowAuto}
          sizeLevels={resolvedSizeLevels}
          aspectPresets={resolvedAspectPresets}
          presetOptions={resolvedPresetOptions}
          constraints={field.constraints}
          disabled={disabled}
          onChange={(next) => onChange(next)}
        />
        {displayErrorText ? (
          <p className="text-xs text-destructive">{displayErrorText}</p>
        ) : helperText ? (
          <p className="text-xs text-muted-foreground">{helperText}</p>
        ) : null}
      </div>
    );
  }

  if (field.type === "file" || field.type === "imageUpload") {
    return (
      <FileUploadInput
        field={field}
        schema={schema}
        values={values}
        modelId={modelId}
        disabled={disabled}
        label={label}
        helperText={helperText}
        displayErrorText={displayErrorText}
        translate={translate}
        onChange={onChange}
        useIconLabels={iconLabels}
      />
    );
  }

  return null;
};

export default FieldInput;
