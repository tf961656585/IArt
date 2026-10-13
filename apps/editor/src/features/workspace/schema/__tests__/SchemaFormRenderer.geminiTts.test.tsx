import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SchemaFormRenderer from "../SchemaFormRenderer";
import type { SchemaFormValues } from "../types";
import { loadSchemaFixtureFromProjection } from "@/client/config/__tests__/fixtures/runtimeProjectionFixtures";

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
    const baseSchema = await loadSchemaFixtureFromProjection(GEMINI_TTS_MODEL_ID);
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
    const baseSchema = await loadSchemaFixtureFromProjection(GEMINI_TTS_MODEL_ID);
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
