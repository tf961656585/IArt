import { useCallback } from "react";
import type {
  SchemaConditionContext,
  SchemaDataFieldDefinition,
  SchemaFormDefinition,
  SchemaFormLevelValidator,
  SchemaFormValues,
} from "../types";
import { evaluateCondition } from "../helpers";
import type { SchemaFieldDictionary } from "../helpers";

export interface SchemaValidationHook<FieldKey extends string> {
  validateField: (
    key: FieldKey,
    currentValues: SchemaFormValues<FieldKey>,
    state: { visible: boolean } | undefined
  ) => Promise<string | null>;
  validateForm: () => Promise<boolean>;
}

export const useSchemaValidation = <FieldKey extends string>(
  schema: SchemaFormDefinition<FieldKey>,
  modelId: string,
  fieldDictionary: SchemaFieldDictionary<FieldKey>,
  valuesRef: React.MutableRefObject<SchemaFormValues<FieldKey>>,
  fieldStates: Record<FieldKey, { visible: boolean; disabled: boolean }>,
  setFieldErrors: React.Dispatch<React.SetStateAction<Record<FieldKey, string | null>>>,
  setFormErrors: React.Dispatch<React.SetStateAction<string[]>>
): SchemaValidationHook<FieldKey> => {
  const validateField = useCallback(
    async (
      key: FieldKey,
      currentValues: SchemaFormValues<FieldKey>,
      state: { visible: boolean } | undefined
    ) => {
      const definition = fieldDictionary.get(key);
      if (!definition) return null;
      if (state && state.visible === false) {
        setFieldErrors((prev) => ({ ...prev, [key]: null }));
        return null;
      }
      const message = await getFieldErrorMessage(definition, currentValues, {
        schema,
        values: currentValues,
        modelId,
        field: definition.key,
      });
      setFieldErrors((prev) => {
        if (prev[key] === message) {
          return prev;
        }
        return { ...prev, [key]: message };
      });
      return message;
    },
    [fieldDictionary, schema, modelId, setFieldErrors]
  );

  const validateForm = useCallback(async (): Promise<boolean> => {
    const validations = Array.from(fieldDictionary.keys()).map((key) =>
      validateField(key, valuesRef.current, fieldStates[key])
    );
    const validationResults = await Promise.all(validations);
    const hasFieldError = validationResults.some((result) => Boolean(result));
    if (hasFieldError) {
      return false;
    }
    const validatorErrors = await runFormValidators(
      schema.formValidators ?? [],
      valuesRef.current,
      {
        field: undefined,
        schema,
        values: valuesRef.current,
        modelId,
      }
    );
    setFormErrors(validatorErrors);
    return validatorErrors.length === 0;
  }, [fieldDictionary, fieldStates, schema, modelId, validateField, valuesRef, setFormErrors]);

  return {
    validateField,
    validateForm,
  };
};

const isValueEmpty = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

const getFieldErrorMessage = async <FieldKey extends string>(
  field: SchemaDataFieldDefinition<FieldKey>,
  values: SchemaFormValues<FieldKey>,
  context: SchemaConditionContext<FieldKey>
): Promise<string | null> => {
  const value = values[field.key];
  const required = field.required
    ? true
    : field.requiredWhen
      ? await evaluateCondition(field.requiredWhen, context)
      : false;
  if (required && isValueEmpty(value)) {
    logFieldValidationFailure(field, context, {
      reason: "required",
      messageKey: "pages:modelWorkspace.form.validation.required",
      requiredEvaluated: required,
      value,
    });
    return "pages:modelWorkspace.form.validation.required";
  }
  if (isValueEmpty(value)) {
    return null;
  }
  const validation = field.validation;
  if (!validation) return null;
  if (
    typeof validation.min === "number" &&
    typeof value === "number" &&
    value < validation.min
  ) {
    logFieldValidationFailure(field, context, {
      reason: "min",
      messageKey: "pages:modelWorkspace.form.validation.min",
      requiredEvaluated: required,
      value,
    });
    return "pages:modelWorkspace.form.validation.min";
  }
  if (
    typeof validation.max === "number" &&
    typeof value === "number" &&
    value > validation.max
  ) {
    logFieldValidationFailure(field, context, {
      reason: "max",
      messageKey: "pages:modelWorkspace.form.validation.max",
      requiredEvaluated: required,
      value,
    });
    return "pages:modelWorkspace.form.validation.max";
  }
  if (
    typeof validation.minLength === "number" &&
    typeof value === "string" &&
    value.length < validation.minLength
  ) {
    logFieldValidationFailure(field, context, {
      reason: "minLength",
      messageKey: "pages:modelWorkspace.form.validation.minLength",
      requiredEvaluated: required,
      value,
    });
    return "pages:modelWorkspace.form.validation.minLength";
  }
  if (
    typeof validation.maxLength === "number" &&
    typeof value === "string" &&
    value.length > validation.maxLength
  ) {
    logFieldValidationFailure(field, context, {
      reason: "maxLength",
      messageKey: "pages:modelWorkspace.form.validation.maxLength",
      requiredEvaluated: required,
      value,
    });
    return "pages:modelWorkspace.form.validation.maxLength";
  }
  if (validation.pattern) {
    const pattern =
      typeof validation.pattern === "string"
        ? new RegExp(validation.pattern)
        : validation.pattern;
    if (typeof value === "string" && !pattern.test(value)) {
      const messageKey =
        validation.patternMessageKey ?? "pages:modelWorkspace.form.validation.pattern";
      logFieldValidationFailure(field, context, {
        reason: "pattern",
        messageKey,
        requiredEvaluated: required,
        value,
      });
      return messageKey;
    }
  }
  if (validation.custom) {
    const customMessage = await validation.custom(value, context);
    if (customMessage) {
      logFieldValidationFailure(field, context, {
        reason: "custom",
        messageKey: customMessage,
        requiredEvaluated: required,
        value,
      });
      return customMessage;
    }
  }
  return null;
};

const logFieldValidationFailure = <FieldKey extends string>(
  field: SchemaDataFieldDefinition<FieldKey>,
  context: SchemaConditionContext<FieldKey>,
  params: { reason: string; messageKey: string; requiredEvaluated: boolean; value: unknown }
) => {
  console.log("[SchemaFormValidation] field validation failed", {
    modelId: context.modelId,
    fieldKey: field.key,
    reason: params.reason,
    messageKey: params.messageKey,
    requiredProp: field.required ?? false,
    requiredEvaluated: params.requiredEvaluated,
    value: params.value,
  });
};

const runFormValidators = async <FieldKey extends string>(
  validators: SchemaFormLevelValidator<FieldKey>[],
  values: SchemaFormValues<FieldKey>,
  context: SchemaConditionContext<FieldKey>
): Promise<string[]> => {
  if (!validators || validators.length === 0) {
    return [];
  }
  const errors: string[] = [];
  for (const validator of validators) {
    const shouldRun = await evaluateCondition(validator.when, context);
    if (!shouldRun) continue;
    const result = await validator.validate(values, context);
    if (result) {
      errors.push(result);
    }
  }
  return errors;
};
