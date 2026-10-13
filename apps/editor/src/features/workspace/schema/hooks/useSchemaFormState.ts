import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DynamicRecord } from '@/client/utils/typeGuards';
import type { SetStateAction } from "react";
import type {
  SchemaConditionContext,
  SchemaDataFieldDefinition,
  SchemaFieldDefinition,
  SchemaFormDefinition,
  SchemaFormValues,
} from "../types";
import {
  buildFieldDictionary,
  deriveInitialValues,
  evaluateCondition,
  isDataField,
  runFieldEvents,
  traverseFields,
  type SchemaFieldDictionary,
} from "../helpers";

type FieldVisibilityMap<FieldKey extends string> = Record<
  FieldKey,
  { visible: boolean; disabled: boolean }
>;

const ignorePromptEmit = (_text: string): undefined => undefined;

export interface SchemaFormState<FieldKey extends string> {
  values: SchemaFormValues<FieldKey>;
  valuesRef: React.MutableRefObject<SchemaFormValues<FieldKey>>;
  fieldErrors: Record<FieldKey, string | null>;
  touched: Record<FieldKey, boolean>;
  formErrors: string[];
  submitting: boolean;
  fieldStates: FieldVisibilityMap<FieldKey>;
  structuralVisibility: Map<string, boolean>;
  sectionVisibility: Record<string, boolean>;
  fieldDictionary: SchemaFieldDictionary<FieldKey>;

  setValues: React.Dispatch<React.SetStateAction<SchemaFormValues<FieldKey>>>;
  setFieldErrors: React.Dispatch<React.SetStateAction<Record<FieldKey, string | null>>>;
  setTouched: React.Dispatch<React.SetStateAction<Record<FieldKey, boolean>>>;
  setFormErrors: React.Dispatch<React.SetStateAction<string[]>>;
  setSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  handleFieldEvents: (
    field: SchemaDataFieldDefinition<FieldKey>,
    value: unknown,
    nextValues: SchemaFormValues<FieldKey>
  ) => Promise<void>;
}

export const useSchemaFormState = <FieldKey extends string>(
  schema: SchemaFormDefinition<FieldKey>,
  modelId: string
): SchemaFormState<FieldKey> => {
  const fieldDictionary = useMemo(() => buildFieldDictionary(schema), [schema]);
  const updateCounterRef = useRef(0);
  const lastKnownPromptValueRef = useRef<{
    value: unknown;
    modelId: string;
    fieldKey: FieldKey | undefined | undefined;
  } | null>(null);
  const initStateRef = useRef<{
    schema: SchemaFormDefinition<FieldKey>;
    modelId: string;
    initialized: boolean;
    cleanupTimer: ReturnType<typeof setTimeout> | null;
  }>({
    schema,
    modelId,
    initialized: false,
    cleanupTimer: null,
  });

  const [values, setValuesInternal] = useState<SchemaFormValues<FieldKey>>(() =>
    deriveInitialValues(schema)
  );
  const valuesRef = useRef(values);
  useEffect(() => {
    valuesRef.current = values;
  }, [values]);
  const tracedSetValues = useCallback(
    (action: SetStateAction<SchemaFormValues<FieldKey>>) => {
      setValuesInternal((prev) => {
        updateCounterRef.current += 1;
        const nextValue =
          typeof action === "function"
            ? (action as (prevState: SchemaFormValues<FieldKey>) => SchemaFormValues<FieldKey>)(prev)
            : action;
        return nextValue;
      });
    },
    [setValuesInternal]
  );

  const [fieldErrors, setFieldErrors] = useState<Record<FieldKey, string | null>>(
    {} as Record<FieldKey, string | null>
  );
  const [touched, setTouched] = useState<Record<FieldKey, boolean>>(
    {} as Record<FieldKey, boolean>
  );
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [fieldStates, setFieldStates] = useState<FieldVisibilityMap<FieldKey>>(
    {} as FieldVisibilityMap<FieldKey>
  );
  const [structuralVisibility, setStructuralVisibility] = useState<Map<string, boolean>>(
    new Map()
  );
  const [sectionVisibility, setSectionVisibility] = useState<Record<string, boolean>>({});

  // 初始化表单: 重置状态 + 执行 mount 事件
  useEffect(() => {
    const initState = initStateRef.current;
    if (initState.cleanupTimer) {
      clearTimeout(initState.cleanupTimer);
      initState.cleanupTimer = null;
    }

    const initUpdateVersion = updateCounterRef.current;

    const schemaChanged = initState.schema !== schema || initState.modelId !== modelId;
    const promptFieldKey = (schema.prompt !== null && schema.prompt !== undefined ? schema.prompt.primaryField : undefined) as FieldKey | undefined;
    const previousPromptValue =
      schemaChanged && promptFieldKey ? (valuesRef.current !== null && valuesRef.current !== undefined ? valuesRef.current[promptFieldKey] : undefined) : undefined;


    const shouldCapturePendingPrompt =
      schemaChanged &&
      promptFieldKey !== undefined &&
      previousPromptValue !== undefined &&
      previousPromptValue !== null &&
      (typeof previousPromptValue !== "string" || previousPromptValue !== "");

    if (shouldCapturePendingPrompt) {
      lastKnownPromptValueRef.current = {
        value: previousPromptValue,
        modelId,
        fieldKey: promptFieldKey,
      };
    }
    if (initState.initialized && !schemaChanged) {
      return;
    }

    let cancelled = false;

    const initializeForm = async () => {
      const promptKey = promptFieldKey;
      const preservedPromptValue = previousPromptValue;
      const shouldPreservePrompt =
        preservedPromptValue !== undefined &&
        preservedPromptValue !== null &&
        (typeof preservedPromptValue !== "string" || preservedPromptValue !== "");

      const exitIfCancelled = (_stage: string) => {
        if (cancelled) {
          return true;
        }
        return false;
      };
      const initialValues = deriveInitialValues(schema);
      const patches: Partial<SchemaFormValues<FieldKey>> = {};
      const dataFields: Array<SchemaDataFieldDefinition<FieldKey>> = [];

      traverseFields<FieldKey>(schema.fields, (field) => {
        if (isDataField(field)) {
          dataFields.push(field as SchemaDataFieldDefinition<FieldKey>);
        }
      });

      let _fieldIndex = 0;
      for (const field of dataFields) {
        if (exitIfCancelled("before-mount-field")) {
          return;
        }
        const currentValue = initialValues[field.key];
        const result = await runFieldEvents(field, "mount", currentValue, {
          field: field.key,
          schema,
          values: initialValues,
          modelId,
          emitPrompt: ignorePromptEmit,
        });
        if (result) {
          Object.assign(patches, result);
        }
        _fieldIndex++;
      }

      if (exitIfCancelled("after-mount-loop")) {
        return;
      }

      let finalValues =
        Object.keys(patches).length > 0 ? { ...initialValues, ...patches } : initialValues;
      if (exitIfCancelled("before-final-values")) {
        return;
      }

      let promptFinalValue: unknown = undefined;

      if (promptKey) {
        let valueToRestore: unknown | undefined;

        if (shouldPreservePrompt) {
          valueToRestore = preservedPromptValue;
        } else if (lastKnownPromptValueRef.current) {
          const pending = lastKnownPromptValueRef.current;
          const match = pending.modelId === modelId;
          if (match) {
            valueToRestore = pending.value;
          }
        }

        if (valueToRestore !== undefined) {
          if (finalValues === initialValues) {
            finalValues = { ...initialValues };
          }
          finalValues[promptKey] = valueToRestore;
          promptFinalValue = finalValues[promptKey];
        } else {
          promptFinalValue = finalValues[promptKey];
        }
      } else {
        promptFinalValue = undefined;
      }

      const hasExternalUpdate = updateCounterRef.current !== initUpdateVersion;

      if (!hasExternalUpdate) {
        tracedSetValues(finalValues);
        valuesRef.current = finalValues;
      } else {
        tracedSetValues((prev) => {
          const merged: SchemaFormValues<FieldKey> = { ...prev };
          (Object.keys(finalValues) as FieldKey[]).forEach((key) => {
            const prevValue = (prev !== null && prev !== undefined ? (prev as DynamicRecord)[key] : undefined);
            const initialValue = (initialValues !== null && initialValues !== undefined ? (initialValues as DynamicRecord)[key] : undefined);
            if (prevValue === initialValue) {
              (merged as DynamicRecord)[key] = (finalValues as DynamicRecord)[
                key
              ];
            }
          });
          valuesRef.current = merged;
          return merged;
        });
      }
      setFieldErrors({} as Record<FieldKey, string | null>);
      setTouched({} as Record<FieldKey, boolean>);
      setFormErrors([]);

      if (exitIfCancelled("before-commit-initState")) {
        return;
      }

      initStateRef.current.schema = schema;
      initStateRef.current.modelId = modelId;
      initStateRef.current.initialized = true;

      if (
        promptKey &&
        promptFinalValue !== undefined &&
        promptFinalValue !== null &&
        (typeof promptFinalValue !== "string" || promptFinalValue !== "")
      ) {
        lastKnownPromptValueRef.current = {
          value: promptFinalValue,
          modelId,
          fieldKey: promptKey,
        };
      }
    };

    void initializeForm();

    return () => {
      cancelled = true;
      initState.cleanupTimer = setTimeout(() => {
        initState.initialized = false;
        initState.cleanupTimer = null;
      }, 0);
    };
  }, [schema, modelId, tracedSetValues]);

  // 实时备份最近一次非空的 prompt 值
  useEffect(() => {
    const promptFieldKey = (schema.prompt !== null && schema.prompt !== undefined ? schema.prompt.primaryField : undefined) as FieldKey | undefined;
    if (!promptFieldKey) {
      return;
    }

    const currentPromptValue = values[promptFieldKey];
    const hasNonEmptyPrompt =
      currentPromptValue !== undefined &&
      currentPromptValue !== null &&
      (typeof currentPromptValue !== "string" || currentPromptValue !== "");

    if (hasNonEmptyPrompt) {
      lastKnownPromptValueRef.current = {
        value: currentPromptValue,
        modelId,
        fieldKey: promptFieldKey,
      };
    }
  }, [values, schema, modelId]);

  // 计算字段显隐/禁用状态 (分片计算避免阻塞)
  useEffect(() => {
    let cancelled = false;
    const nextFieldStates: FieldVisibilityMap<FieldKey> = {} as FieldVisibilityMap<FieldKey>;
    const structuralMap = new Map<string, boolean>();
    const layoutSections = (schema.layout !== null && schema.layout !== undefined ? schema.layout.sections : undefined) ?? [];

    const computeFieldsChunked = async () => {
      const entries: Array<{ field: SchemaFieldDefinition<FieldKey>; path: string }> = [];
      collectFieldEntries(schema.fields, entries);

      const CHUNK_SIZE = 16;
      let index = 0;

      while (index < entries.length && !cancelled) {
        const end = Math.min(index + CHUNK_SIZE, entries.length);
        for (let i = index; i < end; i += 1) {
          const entry = entries[i];
          if (!entry) {
            continue;
          }
          const { field, path } = entry;
          const context: SchemaConditionContext<FieldKey> = {
            field: isDataField(field) ? field.key : undefined,
            schema,
            values,
            modelId,
          };
          const visible = await evaluateCondition<FieldKey>(field.visibleWhen, context);
          if (isDataField(field)) {
            const disabled = field.disabledWhen
              ? await evaluateCondition<FieldKey>(field.disabledWhen, context)
              : false;
            nextFieldStates[field.key] = { visible, disabled };
          } else {
            structuralMap.set(path, visible);
          }
          if (cancelled) {
            return;
          }
        }
        index = end;
        if (index < entries.length) {
          await new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 0);
          });
        }
      }

      if (cancelled) {
        return;
      }

      const sectionStates: Record<string, boolean> = {};
      for (const section of layoutSections) {
        if (cancelled) {
          return;
        }
        const visible = await evaluateCondition(section.visibleWhen, {
          field: undefined,
          schema,
          values,
          modelId,
        });
        sectionStates[section.id] = visible;
      }

      if (cancelled) return;
      setFieldStates(nextFieldStates);
      setStructuralVisibility(structuralMap);
      setSectionVisibility(sectionStates);
    };

    void computeFieldsChunked();
    return () => {
      cancelled = true;
    };
  }, [schema, modelId, values]);

  const handleFieldEvents = useCallback(
    async (
      field: SchemaDataFieldDefinition<FieldKey>,
      value: unknown,
      nextValues: SchemaFormValues<FieldKey>
    ) => {
      const patches = await runFieldEvents(field, "change", value, {
        field: field.key,
        schema,
        values: nextValues,
        modelId,
        emitPrompt: ignorePromptEmit,
      });
      if (patches) {
        tracedSetValues((prev) => {
          const merged = { ...prev, ...patches };
          valuesRef.current = merged;
          return merged;
        });
      }
    },
    [schema, modelId, tracedSetValues]
  );

  return {
    values,
    valuesRef,
    fieldErrors,
    touched,
    formErrors,
    submitting,
    fieldStates,
    structuralVisibility,
    sectionVisibility,
    fieldDictionary,
    setValues: tracedSetValues,
    setFieldErrors,
    setTouched,
    setFormErrors,
    setSubmitting,
    handleFieldEvents,
  };
};

const collectFieldEntries = <FieldKey extends string>(
  fields: Array<SchemaFieldDefinition<FieldKey>>,
  entries: Array<{ field: SchemaFieldDefinition<FieldKey>; path: string }>,
  basePath = "root"
) => {
  fields.forEach((field, index) => {
    const path = `${basePath}.${index}`;
    entries.push({ field, path });
    if (field.type === "group") {
      collectFieldEntries(field.children, entries, path);
    }
  });
};
