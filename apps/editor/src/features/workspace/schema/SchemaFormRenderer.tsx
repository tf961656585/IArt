"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { Alert as ShadAlert } from "@/components/ui/alert";

import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import FieldInputRenderer from "@/features/workspace/schema/renderers/FieldInputRenderer";
import { buildPromptFromCommand } from "@/features/models/shared/promptUtils";
import { isDataField } from "./helpers";
import { sanitizeSxToStyle } from "./styleUtils";
import type {
  SchemaDataFieldDefinition,
  SchemaFieldDefinition,
  SchemaFieldKey,
  SchemaFieldOption,
  SchemaFormDefinition,
  SchemaFormValues,
  SchemaTranslateArgs,
} from "./types";
import type { PromptUpdateCommand } from "../modelFormTypes";
import { useSchemaFormState } from "./hooks/useSchemaFormState";
import { useSchemaValidation } from "./hooks/useSchemaValidation";
import { SchemaFormLayout } from "./components/SchemaFormLayout";

interface SchemaFormRendererProps<FieldKey extends string = SchemaFieldKey> {
  schema: SchemaFormDefinition<FieldKey>;
  modelId: string;
  busy: boolean | undefined;
  error: string | null | undefined;
  messages: string[] | undefined;
  taskListSlot: ReactNode | undefined;
  onSubmit: (values: SchemaFormValues<FieldKey>) => Promise<void> | void | undefined;
  promptCommand: PromptUpdateCommand | null | undefined;
  onPromptCommandHandled: () => void | undefined;
  externalSubmitRef: React.MutableRefObject<(() => void) | null> | null | undefined;
  /** 当 Schema 加载/变更时上报定义 */
  onSchemaResolved: (schema: SchemaFormDefinition<FieldKey>) => void | undefined;
  /** 对外同步表单值变更（用于外部联动读取当前值） */
  onValuesChange: (values: SchemaFormValues<FieldKey>) => void | undefined;
  /**
   * 外部设置单个字段值（幂等）。version 递增用于避免重复应用。
   */
  externalFieldUpdate: { key: FieldKey; value: unknown; version: number } | null | undefined;
  /** 隐藏底部的提交按钮，由外部触发提交 */
  hideSubmit: boolean | undefined;
  /** 使用图标+Tooltip 替代文字标签（用于 Prompt Dock 等紧凑场景） */
  useIconLabels: boolean | undefined;
  /** 若为 true，则由外部渲染 Prompt/图片等首行内容，内部不再输出首行结构 */
  externalTopRow: boolean | undefined;
  /** 外部指定要隐藏的字段 key 集合（用于 Dock 整合版本选择器时隐藏 schema 中的 model 字段） */
  hiddenFieldKeys: Set<FieldKey> | undefined;
}

const defaultSubmit = async (): Promise<void> => {
  // Renderer 允许缺省提交处理（例如仅做展示），调用方可按需提供
};

const SchemaFormRenderer = <FieldKey extends string = SchemaFieldKey>({
  schema,
  modelId,
  busy = false,
  error,
  messages,
  taskListSlot,
  onSubmit = defaultSubmit,
  promptCommand,
  onPromptCommandHandled,
  externalSubmitRef,
  onSchemaResolved,
  onValuesChange,
  externalFieldUpdate,
  hideSubmit = false,
  useIconLabels = false,
  externalTopRow = false,
  hiddenFieldKeys,
}: SchemaFormRendererProps<FieldKey>) => {
  const { t } = useTranslation(["pages", "common"]);
  const translate = useCallback(
    (...args: SchemaTranslateArgs) => {
      const [key, arg2] = args;
      if (!key) {
        return typeof arg2 === "string" ? arg2 : "";
      }
      if (typeof arg2 === "string" || arg2 === undefined) {
        const defaultValue = typeof arg2 === "string" ? arg2 : key;
        return t(key, { defaultValue });
      }
      return t(key, { defaultValue: key, ...arg2 });
    },
    [t]
  );

  const {
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
    setValues,
    setFieldErrors,
    setTouched,
    setFormErrors,
    setSubmitting,
    handleFieldEvents,
  } = useSchemaFormState<FieldKey>(schema, modelId);

  const { validateField, validateForm } = useSchemaValidation<FieldKey>(
    schema,
    modelId,
    fieldDictionary,
    valuesRef,
    fieldStates,
    setFieldErrors,
    setFormErrors
  );

  const asyncOptionsCache = useRef(new Map<string, SchemaFieldOption[]>());

  // 计算首行（仅 Prompt + 图片上传）与抑制集合
  const schemaLayoutColumns = (schema.layout !== null && schema.layout !== undefined ? schema.layout.columns : undefined);
  const promptPrimaryField = (schema.prompt !== null && schema.prompt !== undefined ? schema.prompt.primaryField : undefined) as FieldKey | undefined;

  const usedColumns = useMemo(() => {
    const cols = schemaLayoutColumns ?? 8;
    return (cols < 1 ? 1 : cols > 10 ? 10 : cols) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  }, [schemaLayoutColumns]);

  const topRowKeys = useMemo(() => {
    const keys: FieldKey[] = [];
    const promptKey = promptPrimaryField;
    if (promptKey && ((fieldStates[promptKey] !== null && fieldStates[promptKey] !== undefined ? fieldStates[promptKey].visible : undefined) ?? true)) {
      keys.push(promptKey);
      // 规则：若存在负向提示词（negativePrompt）且可见，将其与 prompt 同行展示
      const neg = schema.fields.find(
        (f): f is SchemaDataFieldDefinition<FieldKey> =>
          isDataField(f) && f.key === ("negativePrompt" as FieldKey)
      );
      if (neg && ((fieldStates[neg.key] !== null && fieldStates[neg.key] !== undefined ? fieldStates[neg.key].visible : undefined) ?? true)) {
        keys.push(neg.key);
      }
    }
    // 按 Schema.fields 中的自然顺序收集可见的图片上传字段
    schema.fields.forEach((f) => {
      if (isDataField(f) && f.type === "imageUpload") {
        if ((fieldStates[f.key] !== null && fieldStates[f.key] !== undefined ? fieldStates[f.key].visible : undefined) ?? true) {
          keys.push(f.key);
        }
      }
    });
    return keys;
  }, [fieldStates, promptPrimaryField, schema.fields]);

  const suppressedFieldKeys = useMemo(() => {
    const keys = new Set<FieldKey>(topRowKeys);
    // 合并外部指定的隐藏字段
    if (hiddenFieldKeys) {
      hiddenFieldKeys.forEach((k) => keys.add(k));
    }
    return keys;
  }, [topRowKeys, hiddenFieldKeys]);

  

  // 上报 Schema 引用
  useEffect(() => {
    if (onSchemaResolved !== null && onSchemaResolved !== undefined) {
      onSchemaResolved(schema);
    }
  }, [onSchemaResolved, schema]);

  // 对外同步当前值（用于外部渲染器读值）
  useEffect(() => {
    if (onValuesChange !== null && onValuesChange !== undefined) {
      onValuesChange(values);
    }
  }, [modelId, onValuesChange, promptPrimaryField, values]);

  // 外部字段写入（单点补丁）
  const lastExternalVersionRef = useRef<number>(-1);
  useEffect(() => {
    if (!externalFieldUpdate) return;
    if (externalFieldUpdate.version === lastExternalVersionRef.current) return;
    lastExternalVersionRef.current = externalFieldUpdate.version;
    const { key, value } = externalFieldUpdate;

    setValues((prev) => {
      const next = { ...prev, [key]: value } as SchemaFormValues<FieldKey>;
      valuesRef.current = next;
      return next;
    });
  }, [externalFieldUpdate, setValues, valuesRef]);

  useEffect(() => {
    if (!promptCommand) return;
    setValues((prev) => {
      const promptConfig = schema.prompt;
      if (!promptConfig) {
        return prev;
      }
      const next = promptConfig.applyCommand
        ? promptConfig.applyCommand(prev, promptCommand) ?? prev
        : (() => {
            const patched = { ...prev };
            const currentPrompt = patched[promptConfig.primaryField];
            patched[promptConfig.primaryField] = buildPromptFromCommand(
              typeof currentPrompt === "string" ? currentPrompt : undefined,
              promptCommand
            );
            return patched;
          })();
      valuesRef.current = next;
      return next;
    });
    if (onPromptCommandHandled !== null && onPromptCommandHandled !== undefined) {
      onPromptCommandHandled();
    }
  }, [promptCommand, schema, onPromptCommandHandled, setValues, valuesRef]);

  const handleFieldValueChange = useCallback(
    (field: SchemaDataFieldDefinition<FieldKey>, nextValue: unknown) => {
      setValues((prev) => {
        const next = { ...prev, [field.key]: nextValue };
        valuesRef.current = next;
        void handleFieldEvents(field, nextValue, next);
        return next;
      });
      setTouched((prev) => ({ ...prev, [field.key]: true }));
      if (touched[field.key]) {
        void validateField(field.key, valuesRef.current, fieldStates[field.key]);
      }
    },
    [fieldStates, touched, handleFieldEvents, validateField, setTouched, setValues, valuesRef]
  );

  const handleFieldBlur = useCallback(
    (field: SchemaDataFieldDefinition<FieldKey>) => {
      setTouched((prev) => ({ ...prev, [field.key]: true }));
      void validateField(field.key, valuesRef.current, fieldStates[field.key]);
    },
    [fieldStates, validateField, setTouched, valuesRef]
  );

  const patchFormValues = useCallback(
    (patch: Partial<SchemaFormValues<FieldKey>>) => {
      if (!patch || Object.keys(patch).length === 0) {
        return;
      }
      setValues((prev) => {
        const next = { ...prev, ...patch };
        valuesRef.current = next;
        return next;
      });
      Object.keys(patch).forEach((key) => {
        const typedKey = key as FieldKey;
        if (!fieldDictionary.has(typedKey)) {
          return;
        }
        setTouched((prev) => ({ ...prev, [typedKey]: true }));
        void validateField(typedKey, valuesRef.current, fieldStates[typedKey]);
      });
    },
    [fieldDictionary, fieldStates, validateField, setTouched, setValues, valuesRef]
  );

  const submitForm = useCallback(async () => {
    console.log("[SchemaFormRenderer] submitForm 调用", {
      modelId,
      busy,
      submitting,
    });
    if (submitting || busy) {
      console.warn("[SchemaFormRenderer] 忽略提交，当前状态不允许", { submitting, busy });
      return;
    }
    setSubmitting(true);
    setFormErrors([]);
    try {
      console.log("[SchemaFormRenderer] 开始执行表单校验");
      const passed = await validateForm();
      if (!passed) {
        console.warn("[SchemaFormRenderer] 表单校验未通过", { modelId });
        return;
      }
      console.log("[SchemaFormRenderer] 校验通过，准备触发 onSubmit", {
        modelId,
        valueKeys: Object.keys(valuesRef.current ?? {}),
      });
      await onSubmit(valuesRef.current);
      console.log("[SchemaFormRenderer] onSubmit 执行完成");
    } catch (err) {
      console.error("[SchemaFormRenderer] submitForm 执行异常", err);
      throw err;
    } finally {
      console.log("[SchemaFormRenderer] submitForm 流程结束");
      setSubmitting(false);
    }
  }, [busy, modelId, onSubmit, setFormErrors, setSubmitting, submitting, validateForm, valuesRef]);

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      console.log("[SchemaFormRenderer] 表单 handleSubmit 捕获到提交事件", {
        modelId,
      });
      event.preventDefault();
      void submitForm();
    },
    [modelId, submitForm]
  );

  useEffect(() => {
    if (!externalSubmitRef) return;
    externalSubmitRef.current = () => {
      console.log("[SchemaFormRenderer] externalSubmitRef 触发提交", { modelId });
      void submitForm();
    };
    return () => {
      if (externalSubmitRef) {
        externalSubmitRef.current = null;
      }
    };
  }, [externalSubmitRef, modelId, submitForm]);

  const renderFieldNode = useCallback(
    (
      field: SchemaFieldDefinition<FieldKey>,
      path: string,
      options: { ignoreSuppression: boolean | undefined } | undefined
    ): ReactNode => {
      if (field.type === "group") {
        const visible = structuralVisibility.get(path);
        if (visible === false) return null;
        // mini 样式为唯一模式：紧凑堆叠，不再渲染分组卡片
        return (
          <div className="flex flex-col gap-2">
            {field.children.map((child, index) => (
              <React.Fragment key={`${path}.${index}`}>
                {renderFieldNode(child, `${path}.${index}`, options)}
              </React.Fragment>
            ))}
          </div>
        );
      }
      if (field.type === "divider") {
        const visible = structuralVisibility.get(path);
        if (visible === false) return null;
        // mini 为唯一模式：不渲染 divider
        return null;
      }
      const fieldState = fieldStates[field.key];
      if (!(options !== null && options !== undefined ? options.ignoreSuppression : undefined) && suppressedFieldKeys.has(field.key)) {
        return null;
      }
      if (fieldState && fieldState.visible === false) {
        return null;
      }
      return (
        <FieldInputRenderer<FieldKey>
          key={`${path}-${field.key}`}
          field={field}
          schema={schema}
          values={values}
          modelId={modelId}
          disabled={Boolean((fieldState !== null && fieldState !== undefined ? fieldState.disabled : undefined)) || busy}
          errorMessage={fieldErrors[field.key] ?? null}
          touched={Boolean(touched[field.key])}
          translate={translate}
          optionsCache={asyncOptionsCache}
          onChange={(next) => handleFieldValueChange(field, next)}
          onBlur={() => handleFieldBlur(field)}
          onPatchValues={patchFormValues}
          useIconLabels={useIconLabels}
          compact={undefined}
        />
      );
    },
    [
      structuralVisibility,
      fieldStates,
      schema,
      values,
      modelId,
      busy,
      fieldErrors,
      touched,
      translate,
      handleFieldValueChange,
      handleFieldBlur,
      patchFormValues,
      suppressedFieldKeys,
      useIconLabels,
    ]
  );

  const submitDisabled = busy || submitting;
  const submitLabel = submitDisabled
    ? translate("pages:modelWorkspace.actions.submitting", "提交中...")
    : translate("pages:modelWorkspace.actions.generate", "开始生成");

  // 取消顶部吸顶行
  const _topRow = null;

  // 仅保留 mini 展示：隐藏标题/描述，压缩间距
  const formBody = (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {/* 顶部首行：Prompt + 图片上传按钮（可由外部托管） */}
      {externalTopRow
        ? null
        : (() => {
            const promptKey = (schema.prompt !== null && schema.prompt !== undefined ? schema.prompt.primaryField : undefined) as FieldKey | undefined;
            const promptField = promptKey ? (fieldDictionary.get(promptKey) as SchemaDataFieldDefinition<FieldKey> | undefined) : undefined;
            // 按 Schema.fields 顺序拿到图片上传字段定义
            const imageUploadFields = schema.fields.filter(
              (f): f is SchemaDataFieldDefinition<FieldKey> => isDataField(f) && f.type === "imageUpload"
            );
            const visibleUploads = imageUploadFields.filter((f) => (fieldStates[f.key] !== null && fieldStates[f.key] !== undefined ? fieldStates[f.key].visible : undefined) ?? true);
            if (!promptField) return null;
            // 负向提示词（可选）
            const negativeField = schema.fields.find(
              (f): f is SchemaDataFieldDefinition<FieldKey> =>
                isDataField(f) && f.key === ("negativePrompt" as FieldKey)
            );
            const promptVisible = (fieldStates[promptField.key] !== null && fieldStates[promptField.key] !== undefined ? fieldStates[promptField.key].visible : undefined) ?? true;
            if (!promptVisible) return null;
            const uploadCount = visibleUploads.length;
            const promptContainerSpan = (usedColumns - (uploadCount as number)) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
            return (
              <div
                data-part="top-row"
                className="grid gap-2"
                style={{ gridTemplateColumns: `repeat(${usedColumns}, minmax(0, 1fr))` }}
              >
                {/* Prompt/NegativePrompt 占据动态列数：= 总列数 - 上传按钮数量；二者尽量平分宽度 */}
                {(() => {
                  const showNegative = negativeField && ((fieldStates[negativeField.key] !== null && fieldStates[negativeField.key] !== undefined ? fieldStates[negativeField.key].visible : undefined) ?? true);
                  if (showNegative) {
                    return (
                      <div
                        key={`top.promptPair.${String(promptField.key)}.${String(negativeField.key)}`}
                        style={{ gridColumn: `span ${promptContainerSpan} / span ${promptContainerSpan}` }}
                      >
                        <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
                          <div
                            data-field-key={String(promptField.key)}
                            style={{
                              position: (promptField.layout !== null && promptField.layout !== undefined ? promptField.layout.sticky : undefined) ? "sticky" : undefined,
                              top: (promptField.layout !== null && promptField.layout !== undefined ? promptField.layout.sticky : undefined) ? "64px" : undefined,
                              ...sanitizeSxToStyle(promptField.sx),
                            }}
                          >
                            {renderFieldNode(promptField, `top.prompt`, { ignoreSuppression: true })}
                          </div>
                          <div
                            data-field-key={String(negativeField.key)}
                            style={{ ...sanitizeSxToStyle(negativeField.sx) }}
                          >
                            {renderFieldNode(negativeField, `top.negative`, { ignoreSuppression: true })}
                          </div>
                        </div>
                      </div>
                    );
                  }
                  // 无负向提示词：Prompt 占据全部容器宽度
                  return (
                    <div
                      key={`top.prompt.${String(promptField.key)}`}
                      data-field-key={String(promptField.key)}
                      style={{
                        gridColumn: `span ${promptContainerSpan} / span ${promptContainerSpan}`,
                        position: (promptField.layout !== null && promptField.layout !== undefined ? promptField.layout.sticky : undefined) ? ("sticky" as const) : undefined,
                        top: (promptField.layout !== null && promptField.layout !== undefined ? promptField.layout.sticky : undefined) ? "64px" : undefined,
                        ...sanitizeSxToStyle(promptField.sx),
                      }}
                    >
                      {renderFieldNode(promptField, `top.prompt`, { ignoreSuppression: true })}
                    </div>
                  );
                })()}
                {visibleUploads.map((uf, idx) => (
                  <div
                    key={`top.upload.${String(uf.key)}.${idx}`}
                    data-field-key={String(uf.key)}
                    style={{ gridColumn: `span 1 / span 1`, ...sanitizeSxToStyle(uf.sx) }}
                  >
                    {renderFieldNode(uf, `top.upload.${idx}`, { ignoreSuppression: true })}
                  </div>
                ))}
              </div>
            );
          })()}
      <SchemaFormLayout<FieldKey>
        schema={schema}
        values={values}
        fieldStates={fieldStates}
        sectionVisibility={sectionVisibility}
        fieldDictionary={fieldDictionary}
        translate={translate}
        renderFieldNode={renderFieldNode}
        suppressedFieldKeys={suppressedFieldKeys}
      />
      {formErrors.length > 0 ? (
        <ShadAlert className="border-destructive/30 text-destructive">
          <div className="flex flex-col gap-1">
            {formErrors.map((item, index) => (
              <div key={index} className="text-sm">{translate(item, item)}</div>
            ))}
          </div>
        </ShadAlert>
      ) : null}
      {error ? (
        <ShadAlert className="border-destructive/30 text-destructive">
          <div className="text-sm col-start-2">{error}</div>
        </ShadAlert>
      ) : null}
      {Array.isArray(messages) && messages.length > 0 ? (
        <ShadAlert>
          <div className="flex flex-col gap-1">
            {messages.map((message, index) => (
              <div key={index} className="text-sm">{message}</div>
            ))}
          </div>
        </ShadAlert>
      ) : null}
      {hideSubmit ? null : (
        <div className="flex justify-end">
          <Button type="submit" disabled={submitDisabled}>
            {submitLabel}
          </Button>
        </div>
      )}
    </form>
  );

  const slotPosition = (schema.responseHandling !== null && schema.responseHandling !== undefined ? schema.responseHandling.taskListSlot : undefined) ?? "right";
  const layout =
    taskListSlot && slotPosition !== "bottom" ? (
      <div
        className={
          "flex gap-2 items-start " + (slotPosition === "left" ? "flex-row-reverse" : "flex-row")
        }
      >
        <div className="flex-1">{formBody}</div>
        <div className="w-full md:w-[320px] flex-shrink-0">{taskListSlot}</div>
      </div>
    ) : (
      <>
        {formBody}
        {taskListSlot ? <div className="mt-2">{taskListSlot}</div> : null}
      </>
    );

  return <div className="flex flex-col gap-2">{layout}</div>;
};

// prompt/媒体的 Dock 桥接逻辑已移除，Schema 直接管理全部字段

export default SchemaFormRenderer;
