import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SchemaFormRenderer from "../SchemaFormRenderer";
import type { SchemaFormDefinition, SchemaFormValues } from "../types";

type ResizeObserverStub = {
  observe: () => void;
  unobserve: () => void;
  disconnect: () => void;
};

const testGlobal = globalThis as typeof globalThis & {
  ResizeObserver?: new () => ResizeObserverStub;
};

if (typeof testGlobal.ResizeObserver === "undefined") {
  testGlobal.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const noopSubmit = (): void => {};
const noopHandled = (): void => {};
const noopSchemaResolved = (): void => {};

const GEMINI_TTS_MODEL_ID = "gemini-2.5-flash-preview-tts";

/**
 * 多人配音表单的最小 schema（内联夹具）。
 *
 * 历史：本文件原从包目录里的真实 TTS 包加载 schema。2026-10-20 模型能力包
 * 退场后，TTS 在契约的 7 个生成接口类型里没有对应族（族模板只管图像/视频生成），因此它的表单
 * 形态不再有生产来源；本文件要测的只剩**渲染器行为**（结构化行对编辑器如何读写字符串值），
 * 与模型来源无关，故改为内联 schema。
 */
const buildGeminiTtsSchema = (): SchemaFormDefinition<string> => ({
  meta: {
    id: "gemini-tts-test",
    version: "1.0.0",
    modelId: GEMINI_TTS_MODEL_ID,
    titleKey: undefined,
    descriptionKey: undefined,
    docLinkKey: undefined,
  },
  fields: [
    {
      key: "mode",
      type: "select",
      labelKey: "mode",
      helperTextKey: undefined,
      helperTextParams: undefined,
      placeholderKey: undefined,
      tooltipKey: undefined,
      descriptionKey: undefined,
      layout: undefined,
      visibleWhen: undefined,
      disabledWhen: undefined,
      required: undefined,
      requiredWhen: undefined,
      validation: undefined,
      events: undefined,
      metadata: undefined,
      defaultValue: "single",
      className: undefined,
      sx: undefined,
      multiple: undefined,
      renderValueKey: undefined,
      clearable: undefined,
      options: {
        kind: "static",
        options: [
          {
            value: "single",
            labelKey: "single",
            labelParams: undefined,
            descriptionKey: undefined,
            helperKey: undefined,
            disabledWhen: undefined,
            icon: undefined,
            groupKey: undefined,
          },
          {
            value: "multi",
            labelKey: "multi",
            labelParams: undefined,
            descriptionKey: undefined,
            helperKey: undefined,
            disabledWhen: undefined,
            icon: undefined,
            groupKey: undefined,
          },
        ],
      },
    },
    {
      key: "speakerVoiceLines",
      type: "textarea",
      labelKey: "speakerVoiceLines",
      helperTextKey: undefined,
      helperTextParams: undefined,
      placeholderKey: undefined,
      tooltipKey: undefined,
      descriptionKey: undefined,
      layout: undefined,
      visibleWhen: { field: "mode", op: "eq", value: "multi" },
      disabledWhen: undefined,
      required: undefined,
      requiredWhen: undefined,
      validation: undefined,
      events: undefined,
      metadata: {
        editor: "structuredLinePairs",
        separator: "|",
        leftLabelKey: "角色名",
        rightLabelKey: "声音名",
        addButtonLabelKey: "新增角色",
        removeButtonLabelKey: "删除",
      },
      defaultValue: "",
      className: undefined,
      sx: undefined,
      minRows: undefined,
      maxRows: undefined,
      autoResize: undefined,
      showCounter: undefined,
    },
  ],
  layout: undefined,
  defaults: undefined,
  formValidators: undefined,
  prompt: undefined,
  payload: {
    format: "json",
    format_rule: undefined,
    taskType: undefined,
    map: {},
    hooks: undefined,
  },
  responseHandling: undefined,
});

vi.mock("react-i18next", () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      typeof opts?.defaultValue === "string" ? opts.defaultValue : key,
  }),
}));

describe("SchemaFormRenderer - Gemini TTS", () => {
  afterEach(() => {
    cleanup();
  });

  it("多人模式会渲染 speakerVoiceLines 结构化编辑器并回写字符串值", async () => {
    const baseSchema = buildGeminiTtsSchema();
    const handleValuesChange = vi.fn<(values: SchemaFormValues<string>) => void>();
    const schema = {
      ...baseSchema,
      defaults: {
        ...(baseSchema.defaults ?? {}),
        mode: "multi",
        speakerVoiceLines: "Joe|Kore",
      },
    };

    render(
      <SchemaFormRenderer
        schema={schema}
        modelId={GEMINI_TTS_MODEL_ID}
        busy={false}
        error={null}
        messages={undefined}
        taskListSlot={undefined}
        onSubmit={noopSubmit}
        promptCommand={null}
        onPromptCommandHandled={noopHandled}
        externalSubmitRef={undefined}
        onSchemaResolved={noopSchemaResolved}
        onValuesChange={handleValuesChange}
        externalFieldUpdate={null}
        hideSubmit={true}
        useIconLabels={false}
        externalTopRow={false}
        hiddenFieldKeys={undefined}
      />
    );

    const speakerNameInput = await screen.findByLabelText("角色名-1");
    fireEvent.change(speakerNameInput, {
      target: { value: "Jane" },
    });

    await waitFor(() => {
      const lastCall = handleValuesChange.mock.calls.at(-1);
      expect(lastCall).toBeTruthy();
      const latestValues = lastCall?.[0] as Record<string, unknown>;
      expect(latestValues['speakerVoiceLines']).toBe("Jane|Kore");
    });
  });

  it("speakerVoiceLines 清空时会立刻回写空值", async () => {
    const baseSchema = buildGeminiTtsSchema();
    const handleValuesChange = vi.fn<(values: SchemaFormValues<string>) => void>();
    const schema = {
      ...baseSchema,
      defaults: {
        ...(baseSchema.defaults ?? {}),
        mode: "multi",
        speakerVoiceLines: "Joe|Kore",
      },
    };

    render(
      <SchemaFormRenderer
        schema={schema}
        modelId={GEMINI_TTS_MODEL_ID}
        busy={false}
        error={null}
        messages={undefined}
        taskListSlot={undefined}
        onSubmit={noopSubmit}
        promptCommand={null}
        onPromptCommandHandled={noopHandled}
        externalSubmitRef={undefined}
        onSchemaResolved={noopSchemaResolved}
        onValuesChange={handleValuesChange}
        externalFieldUpdate={null}
        hideSubmit={true}
        useIconLabels={false}
        externalTopRow={false}
        hiddenFieldKeys={undefined}
      />
    );

    const removeButton = await screen.findByRole("button", { name: "删除" });
    fireEvent.click(removeButton);

    await waitFor(() => {
      const lastCall = handleValuesChange.mock.calls.at(-1);
      expect(lastCall).toBeTruthy();
      const latestValues = lastCall?.[0] as Record<string, unknown>;
      expect(latestValues['speakerVoiceLines']).toBe("");
    });
  });
});
