import React, { type ReactNode } from "react";

import type {
  SchemaFieldDefinition,
  SchemaFormDefinition,
  SchemaFormValues,
  SchemaTranslate,
} from "../types";
import { isDataField } from "../helpers";
import type { SchemaFieldDictionary } from "../helpers";
import { sanitizeSxToStyle } from "../styleUtils";

interface SchemaFormLayoutProps<FieldKey extends string> {
  schema: SchemaFormDefinition<FieldKey>;
  values: SchemaFormValues<FieldKey>;
  fieldStates: Record<FieldKey, { visible: boolean; disabled: boolean }>;
  sectionVisibility: Record<string, boolean>;
  fieldDictionary: SchemaFieldDictionary<FieldKey>;
  translate: SchemaTranslate;
  renderFieldNode: (
    field: SchemaFieldDefinition<FieldKey>,
    path: string,
    options: { ignoreSuppression: boolean | undefined } | undefined
  ) => ReactNode;
  suppressedFieldKeys: Set<FieldKey>;
}

export const SchemaFormLayout = <FieldKey extends string>({
  schema,
  fieldStates,
  sectionVisibility,
  fieldDictionary,
  translate,
  renderFieldNode,
  suppressedFieldKeys,
}: SchemaFormLayoutProps<FieldKey>) => {
  const renderFieldGrid = (
    fields: Array<SchemaFieldDefinition<FieldKey>>,
    basePath: string,
    columns: number | undefined
  ) => {
    const rawColumns = columns ?? (schema.layout !== null && schema.layout !== undefined ? schema.layout.columns : undefined) ?? 1;
    const columnCount = Math.max(1, Math.min(rawColumns, 10));
    // 使用内联样式始终应用多列布局，不依赖响应式断点
    // 这确保在 Dock 等紧凑场景下参数也能横向排列
    return (
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
      >
        {fields.map((field, index) => {
          const path = `${basePath}.${index}`;
          if (isDataField(field) && suppressedFieldKeys.has(field.key)) {
            return null;
          }
          if (isDataField(field) && ((fieldStates[field.key] !== null && fieldStates[field.key] !== undefined ? fieldStates[field.key].visible : undefined) ?? true) === false) {
            return null;
          }
          const content = renderFieldNode(field, path, undefined);
          if (!content) return null;
          const desiredSpan = (field.layout !== null && field.layout !== undefined ? field.layout.colSpan : undefined) ?? 1;
          const colSpan = Math.max(1, Math.min(desiredSpan, columnCount));
          return (
            <div
              key={path}
              className={field.className as string | undefined}
              data-field-key={isDataField(field) ? String(field.key) : undefined}
              style={{
                gridColumn: `span ${colSpan} / span ${colSpan}`,
                position: (field.layout !== null && field.layout !== undefined ? field.layout.sticky : undefined) ? ("sticky" as const) : undefined,
                top: (field.layout !== null && field.layout !== undefined ? field.layout.sticky : undefined) ? "64px" : undefined,
                ...sanitizeSxToStyle(field.sx),
              }}
            >
              {content}
            </div>
          );
        })}
      </div>
    );
  };

  const layoutSections = (schema.layout !== null && schema.layout !== undefined ? schema.layout.sections : undefined) ?? [];
  const usedFieldKeys = new Set<FieldKey>();
  const sectionBlocks = layoutSections.map((section) => {
    const visible = sectionVisibility[section.id] ?? true;
    if (!visible) return null;
    const sectionFields =
      section.fields !== null && section.fields !== undefined
        ? section.fields.map((key) => {
        const field = fieldDictionary.get(key);
        if (field) {
          usedFieldKeys.add(key);
        }
        return field;
      })
        : [];
    const filteredFields = sectionFields.filter(Boolean) as Array<
      SchemaFieldDefinition<FieldKey>
    >;
    if (filteredFields.length === 0) {
      return null;
    }
    return (
      <div key={section.id} className="flex flex-col gap-3">
        {section.titleKey ? (
          <div className="text-base font-semibold">{translate(section.titleKey)}</div>
        ) : null}
        {section.descriptionKey ? (
          <div className="text-sm text-muted-foreground">{translate(section.descriptionKey)}</div>
        ) : null}
        {renderFieldGrid(filteredFields, `section-${section.id}`, section.columns)}
      </div>
    );
  });

  const remainingFields = schema.fields.filter(
    (field): field is SchemaFieldDefinition<FieldKey> =>
      !isDataField(field) || (field.key ? !usedFieldKeys.has(field.key) : true)
  );

  return (
    <>
      {sectionBlocks}
      {renderFieldGrid(remainingFields, "root", undefined)}
    </>
  );
};
