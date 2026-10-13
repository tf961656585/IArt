"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isDataField, traverseFields } from "@/features/workspace/schema/helpers";
import type { SchemaFieldOption, SchemaFormDefinition } from "@/features/workspace/schema/types";

interface StructuredLinePairCandidate {
  editor: unknown | undefined;
  separator: unknown | undefined;
  leftLabelKey: unknown | undefined;
  rightLabelKey: unknown | undefined;
  leftPlaceholderKey: unknown | undefined;
  rightPlaceholderKey: unknown | undefined;
  addButtonLabelKey: unknown | undefined;
  removeButtonLabelKey: unknown | undefined;
  voiceFieldKey: unknown | undefined;
}

export type StructuredLinePair = {
  left: string;
  right: string;
};

export type StructuredLinePairRightOption = {
  value: string;
  label: string;
};

export type StructuredLinePairEditorMetadata = {
  editor: "structuredLinePairs";
  separator: string;
  leftLabelKey: string | undefined;
  rightLabelKey: string | undefined;
  leftPlaceholderKey: string | undefined;
  rightPlaceholderKey: string | undefined;
  addButtonLabelKey: string | undefined;
  removeButtonLabelKey: string | undefined;
  voiceFieldKey: string | undefined;
};

export const getStructuredLinePairEditorMetadata = (
  metadata: unknown
): StructuredLinePairEditorMetadata | null => {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const candidate = metadata as StructuredLinePairCandidate;
  if (candidate.editor !== "structuredLinePairs") {
    return null;
  }

  return {
    editor: "structuredLinePairs",
    separator: typeof candidate.separator === "string" && candidate.separator ? candidate.separator : "|",
    leftLabelKey: typeof candidate.leftLabelKey === "string" ? candidate.leftLabelKey : undefined,
    rightLabelKey: typeof candidate.rightLabelKey === "string" ? candidate.rightLabelKey : undefined,
    leftPlaceholderKey:
      typeof candidate.leftPlaceholderKey === "string" ? candidate.leftPlaceholderKey : undefined,
    rightPlaceholderKey:
      typeof candidate.rightPlaceholderKey === "string" ? candidate.rightPlaceholderKey : undefined,
    addButtonLabelKey:
      typeof candidate.addButtonLabelKey === "string" ? candidate.addButtonLabelKey : undefined,
    removeButtonLabelKey:
      typeof candidate.removeButtonLabelKey === "string" ? candidate.removeButtonLabelKey : undefined,
    voiceFieldKey:
      typeof candidate.voiceFieldKey === "string" && candidate.voiceFieldKey ? candidate.voiceFieldKey : undefined,
  };
};

export function resolveStructuredLinePairRightOptions<FieldKey extends string>(
  schema: SchemaFormDefinition<FieldKey> | null,
  voiceFieldKey: string | undefined,
  translateOption: (option: SchemaFieldOption) => string
): StructuredLinePairRightOption[] | undefined {
  if (!voiceFieldKey) return undefined;
  if (!schema) return undefined;
  const targetOptions: SchemaFieldOption[] = [];
  traverseFields(schema.fields, (field) => {
    if (targetOptions.length > 0) return;
    if (!isDataField(field)) return;
    if (field.key !== voiceFieldKey) return;
    if (field.type !== "select" && field.type !== "radio" && field.type !== "toggle") return;
    if (field.options.kind !== "static") return;
    targetOptions.push(...field.options.options);
  });
  if (targetOptions.length === 0) return undefined;
  const resolved = targetOptions
    .map((opt) => {
      const value = typeof opt.value === "string" || typeof opt.value === "number" ? String(opt.value) : null;
      if (value === null) return null;
      const label = translateOption(opt);
      return { value, label };
    })
    .filter((item): item is StructuredLinePairRightOption => item !== null);
  return resolved.length > 0 ? resolved : undefined;
}

const createBlankPair = (): StructuredLinePair => ({ left: "", right: "" });

export const parseStructuredLinePairs = (
  value: unknown,
  separator = "|"
): StructuredLinePair[] => {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const separatorIndex = line.indexOf(separator);
      if (separatorIndex < 0) {
        return {
          left: line.trim(),
          right: "",
        };
      }

      return {
        left: line.slice(0, separatorIndex).trim(),
        right: line.slice(separatorIndex + separator.length).trim(),
      };
    });
};

export const serializeStructuredLinePairs = (
  pairs: StructuredLinePair[],
  separator = "|"
): string => {
  const normalized = Array.isArray(pairs) ? pairs : [];
  if (normalized.length === 0) {
    return "";
  }

  return normalized
    .map((pair) => {
      const left = typeof pair.left === "string" ? pair.left.trim() : "";
      const right = typeof pair.right === "string" ? pair.right.trim() : "";
      return `${left}${separator}${right}`;
    })
    .join("\n");
};

interface StructuredLinePairEditorProps {
  value: unknown;
  disabled: boolean | undefined;
  separator: string | undefined;
  leftLabel: string;
  rightLabel: string;
  leftPlaceholder: string | undefined;
  rightPlaceholder: string | undefined;
  addButtonLabel: string;
  removeButtonLabel: string;
  rightOptions: StructuredLinePairRightOption[] | undefined;
  onChange: (value: string) => void;
}

export function StructuredLinePairEditor({
  value,
  disabled = false,
  separator = "|",
  leftLabel,
  rightLabel,
  leftPlaceholder,
  rightPlaceholder,
  addButtonLabel,
  removeButtonLabel,
  rightOptions,
  onChange,
}: StructuredLinePairEditorProps) {
  const externalRows = useMemo(() => parseStructuredLinePairs(value, separator), [separator, value]);
  const [rows, setRows] = useState<StructuredLinePair[]>(
    externalRows.length > 0 ? externalRows : [createBlankPair()]
  );

  useEffect(() => {
    setRows(externalRows.length > 0 ? externalRows : [createBlankPair()]);
  }, [externalRows]);

  const commitRows = (nextRows: StructuredLinePair[]) => {
    if (nextRows.length === 0) {
      setRows([createBlankPair()]);
      onChange("");
      return;
    }

    setRows(nextRows);
    onChange(serializeStructuredLinePairs(nextRows, separator));
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={`pair-row-${index}`} className="rounded-md border border-border/70 p-3">
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{leftLabel}</Label>
                <Input
                  aria-label={`${leftLabel}-${index + 1}`}
                  value={row.left}
                  placeholder={leftPlaceholder}
                  disabled={disabled}
                  onChange={(event) => {
                    const nextRows = rows.map((item, rowIndex) =>
                      rowIndex === index ? { ...item, left: event.target.value } : item
                    );
                    commitRows(nextRows);
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">{rightLabel}</Label>
                {rightOptions !== undefined && rightOptions.length > 0 ? (
                  <Select
                    value={row.right}
                    disabled={disabled}
                    onValueChange={(next) => {
                      const nextRows = rows.map((item, rowIndex) =>
                        rowIndex === index ? { ...item, right: next } : item
                      );
                      commitRows(nextRows);
                    }}
                  >
                    <SelectTrigger size="default" aria-label={`${rightLabel}-${index + 1}`}>
                      <SelectValue placeholder={rightPlaceholder ?? rightLabel} />
                    </SelectTrigger>
                    <SelectContent>
                      {rightOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    aria-label={`${rightLabel}-${index + 1}`}
                    value={row.right}
                    placeholder={rightPlaceholder}
                    disabled={disabled}
                    onChange={(event) => {
                      const nextRows = rows.map((item, rowIndex) =>
                        rowIndex === index ? { ...item, right: event.target.value } : item
                      );
                      commitRows(nextRows);
                    }}
                  />
                )}
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    const nextRows = rows.filter((_, rowIndex) => rowIndex !== index);
                    commitRows(nextRows);
                  }}
                >
                  {removeButtonLabel}
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => {
          commitRows([...rows, createBlankPair()]);
        }}
      >
        {addButtonLabel}
      </Button>
    </div>
  );
}

export default StructuredLinePairEditor;
