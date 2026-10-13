import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeParameterField,
  validatePortFieldKeyConsistency,
} from "../local-server/model-package-catalog.parameter-schema.cts";
import type { CatalogParameterField, CatalogPort } from "../local-server/model-package-catalog.types.cts";

void test("normalizeParameterField: select clearable component prop is preserved", () => {
  const field = normalizeParameterField(
    {
      field_key: "size",
      label: "Size",
      component: "select",
      required: false,
      enum_options: [
        { value: "1024x1024", label: "Square" },
        { value: "1536x1024", label: "Landscape" },
      ],
      component_props: {
        clearable: true,
      },
    },
    0,
  );

  assert.equal(field.component_props?.clearable, true);
});

void test("normalizeParameterField: constrained imageSize component props are preserved", () => {
  const field = normalizeParameterField(
    {
      field_key: "size",
      label: "Size",
      component: "imageSize",
      required: false,
      default_value: "auto",
      component_props: {
        mode: "constrainedResolution",
        allowAuto: true,
        sizeLevels: [
          { id: "2k", label: "2K", pixelBudget: 4194304 },
          { id: "4k", label: "4K", pixelBudget: 8294400 },
        ],
        aspectPresets: [
          { id: "16:9", label: "16:9", ratio: 16 / 9 },
          { id: "9:16", label: "9:16", ratio: 9 / 16 },
        ],
        presetOptions: [
          { value: "auto", label: "Auto" },
        ],
        customPresets: [
          { value: "1024x1024" },
          { value: "1536x1024", label: "Landscape" },
        ],
        constraints: {
          dimensionMultiple: 16,
          maxLongEdge: 3840,
          minPixels: 655360,
          maxPixels: 8294400,
          maxAspectRatio: 3,
        },
      },
    },
    0,
  );

  assert.equal(field.component_props?.mode, "constrainedResolution");
  assert.equal(field.component_props?.allowAuto, true);
  assert.deepEqual(field.component_props?.sizeLevels?.[1], {
    id: "4k",
    label: "4K",
    pixelBudget: 8294400,
  });
  assert.deepEqual(field.component_props?.aspectPresets?.[0], {
    id: "16:9",
    label: "16:9",
    ratio: 16 / 9,
  });
  assert.deepEqual(field.component_props?.presetOptions?.[0], {
    value: "auto",
    label: "Auto",
  });
  assert.deepEqual(field.component_props?.customPresets, [
    { value: "1024x1024" },
    { value: "1536x1024", label: "Landscape" },
  ]);
  assert.deepEqual(field.component_props?.constraints, {
    dimensionMultiple: 16,
    maxLongEdge: 3840,
    minPixels: 655360,
    maxPixels: 8294400,
    maxAspectRatio: 3,
  });
});

const makePort = (overrides: Partial<CatalogPort> = {}): CatalogPort => ({
  id: overrides.id || "prompt",
  name: overrides.name || "Prompt",
  data_type: overrides.data_type || "text",
  field_key: overrides.field_key || "prompt",
  required: overrides.required !== undefined ? overrides.required : true,
  multiple: overrides.multiple !== undefined ? overrides.multiple : false,
  max_connections: overrides.max_connections,
  description: overrides.description,
  visible_when: overrides.visible_when,
});

const makeField = (fieldKey: string): CatalogParameterField => ({
  field_key: fieldKey,
  label: fieldKey,
  description: undefined,
  component: "textarea",
  component_props: undefined,
  data_source: undefined,
  required: true,
  default_value: undefined,
  enum_options: undefined,
  validation_rules: undefined,
  layout: undefined,
  visible_when: undefined,
  metadata: undefined,
});

void test("validatePortFieldKeyConsistency: throws when port field_key not in parameter_schema", () => {
  const inputPorts: CatalogPort[] = [
    makePort({ field_key: "prompt" }),
    makePort({ id: "image", field_key: "image" }),
  ];
  const parameterFields: CatalogParameterField[] = [
    makeField("prompt"),
  ];
  assert.throws(
    () =>
      validatePortFieldKeyConsistency({
        inputPorts,
        parameterFields,
        packageId: "test-pkg",
      }),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      return error.message.includes("port_field_key_not_in_parameter_schema:[test-pkg]image");
    },
  );
});

void test("validatePortFieldKeyConsistency: passes when all field_keys match", () => {
  const inputPorts: CatalogPort[] = [
    makePort({ field_key: "prompt" }),
    makePort({ id: "image", field_key: "image" }),
  ];
  const parameterFields: CatalogParameterField[] = [
    makeField("prompt"),
    makeField("image"),
  ];
  validatePortFieldKeyConsistency({
    inputPorts,
    parameterFields,
    packageId: "test-pkg",
  });
});

void test("validatePortFieldKeyConsistency: skips validation when parameterFields is empty (backward compat)", () => {
  const inputPorts: CatalogPort[] = [
    makePort({ field_key: "prompt" }),
  ];
  const parameterFields: CatalogParameterField[] = [];
  validatePortFieldKeyConsistency({
    inputPorts,
    parameterFields,
    packageId: "test-pkg",
  });
});

void test("validatePortFieldKeyConsistency: port without field_key uses id as fallback and passes", () => {
  const inputPorts: CatalogPort[] = [
    makePort({ id: "prompt", field_key: "prompt" }),
  ];
  const parameterFields: CatalogParameterField[] = [
    makeField("prompt"),
  ];
  validatePortFieldKeyConsistency({
    inputPorts,
    parameterFields,
    packageId: "test-pkg",
  });
});
