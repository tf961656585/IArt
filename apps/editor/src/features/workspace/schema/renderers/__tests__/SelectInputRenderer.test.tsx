import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SelectFieldInput } from "../SelectInputRenderer";
import type {
  SchemaFieldOption,
  SchemaFormDefinition,
  SchemaFormValues,
  SchemaSelectField,
  SchemaTranslate,
} from "../../types";

type TestFieldKey = "size";

const translate: SchemaTranslate = (...args) => {
  const [key, arg2] = args;
  if (!key) return typeof arg2 === "string" ? arg2 : "";
  if (typeof arg2 === "string") return arg2;
  return key;
};

const schema: SchemaFormDefinition<TestFieldKey> = {
  meta: {
    id: "select-test",
    version: "1.0.0",
    modelId: "test-model",
    titleKey: undefined,
    descriptionKey: undefined,
    docLinkKey: undefined,
  },
  fields: [],
  layout: undefined,
  defaults: undefined,
  formValidators: undefined,
  prompt: undefined,
  payload: { format: undefined, format_rule: undefined, taskType: undefined, map: {}, hooks: undefined },
  responseHandling: undefined,
};

const options: SchemaFieldOption[] = [
  {
    value: "1024x1024",
    labelKey: "Square",
    labelParams: undefined,
    descriptionKey: undefined,
    helperKey: undefined,
    disabledWhen: undefined,
    icon: undefined,
    groupKey: undefined,
  },
  {
    value: "1536x1024",
    labelKey: "Landscape",
    labelParams: undefined,
    descriptionKey: undefined,
    helperKey: undefined,
    disabledWhen: undefined,
    icon: undefined,
    groupKey: undefined,
  },
];

const renderSelect = (
  fieldPatch: { clearable: boolean | undefined },
  values: SchemaFormValues<TestFieldKey>,
) => {
  const field: SchemaSelectField<TestFieldKey> = {
    key: "size",
    type: "select",
    labelKey: "Size",
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
    defaultValue: undefined,
    className: undefined,
    sx: undefined,
    options: { kind: "static", options },
    multiple: undefined,
    renderValueKey: undefined,
    ...fieldPatch,
  };
  const onChange = vi.fn();
  const onBlur = vi.fn();

  render(
    <SelectFieldInput
      field={field}
      schema={schema}
      values={values}
      modelId="test-model"
      disabled={false}
      label="Size"
      helperText=""
      errorText={null}
      placeholder={undefined}
      translate={translate}
      optionsCache={{ current: new Map() }}
      onChange={onChange}
      onBlur={onBlur}
      useIconLabels={undefined}
    />,
  );

  return { onChange, onBlur };
};

describe("SelectFieldInput", () => {
  it("clearable 单选字段允许保持空值，不会自动选中第一项", () => {
    const { onChange } = renderSelect({ clearable: true }, { size: "" });

    expect(screen.getByRole("button", { name: "请选择" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clearable 单选字段可以从已选项清空", async () => {
    const user = userEvent.setup();
    const { onChange, onBlur } = renderSelect({ clearable: true }, { size: "1024x1024" });

    await user.click(screen.getByRole("button", { name: "Square" }));
    await user.click(await screen.findByText("清除"));

    expect(onChange).toHaveBeenCalledWith("");
    expect(onBlur).toHaveBeenCalledOnce();
  });
});
