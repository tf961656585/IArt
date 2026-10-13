import assert from "node:assert/strict";
import test from "node:test";

import { normalizeParameterField } from "../local-server/model-package-catalog.parameter-schema.cts";

void test("normalizeParameterField: visible_when with eq op is preserved", () => {
  const field = normalizeParameterField(
    {
      field_key: "referenceImage",
      label: "Reference Image",
      component: "imageUpload",
      required: false,
      visible_when: {
        field: "imageMode",
        op: "eq",
        value: "reference",
      },
      component_props: {},
    },
    0,
  );

  assert.ok(field.visible_when !== undefined);
  assert.equal(field.visible_when.field, "imageMode");
  assert.equal(field.visible_when.op, "eq");
  assert.equal(field.visible_when.value, "reference");
});

void test("normalizeParameterField: visible_when with in op and array value is preserved", () => {
  const field = normalizeParameterField(
    {
      field_key: "firstFrame",
      label: "First Frame",
      component: "imageUpload",
      required: false,
      visible_when: {
        field: "imageMode",
        op: "in",
        value: ["firstFrame", "keyframes"],
      },
      component_props: {},
    },
    0,
  );

  assert.ok(field.visible_when !== undefined);
  assert.equal(field.visible_when.op, "in");
  assert.deepEqual(field.visible_when.value, ["firstFrame", "keyframes"]);
});

void test("normalizeParameterField: visible_when with neq op is preserved", () => {
  const field = normalizeParameterField(
    {
      field_key: "testField",
      label: "Test",
      component: "text",
      required: false,
      visible_when: {
        field: "mode",
        op: "neq",
        value: "advanced",
      },
    },
    0,
  );

  assert.ok(field.visible_when !== undefined);
  assert.equal(field.visible_when.op, "neq");
  assert.equal(field.visible_when.value, "advanced");
});

void test("normalizeParameterField: visible_when with not_in op is preserved", () => {
  const field = normalizeParameterField(
    {
      field_key: "testField",
      label: "Test",
      component: "text",
      required: false,
      visible_when: {
        field: "mode",
        op: "not_in",
        value: ["hidden", "disabled"],
      },
    },
    0,
  );

  assert.ok(field.visible_when !== undefined);
  assert.equal(field.visible_when.op, "not_in");
  assert.deepEqual(field.visible_when.value, ["hidden", "disabled"]);
});

void test("normalizeParameterField: visible_when with invalid op returns undefined", () => {
  const field = normalizeParameterField(
    {
      field_key: "testField",
      label: "Test",
      component: "text",
      required: false,
      visible_when: {
        field: "mode",
        op: "invalid_op",
        value: "test",
      },
    },
    0,
  );

  assert.equal(field.visible_when, undefined);
});

void test("normalizeParameterField: visible_when missing field returns undefined", () => {
  const field = normalizeParameterField(
    {
      field_key: "testField",
      label: "Test",
      component: "text",
      required: false,
      visible_when: {
        op: "eq",
        value: "test",
      },
    },
    0,
  );

  assert.equal(field.visible_when, undefined);
});

void test("normalizeParameterField: visible_when with in op but non-array value returns undefined", () => {
  const field = normalizeParameterField(
    {
      field_key: "testField",
      label: "Test",
      component: "text",
      required: false,
      visible_when: {
        field: "mode",
        op: "in",
        value: "not-an-array",
      },
    },
    0,
  );

  assert.equal(field.visible_when, undefined);
});

void test("normalizeParameterField: without visible_when has undefined", () => {
  const field = normalizeParameterField(
    {
      field_key: "testField",
      label: "Test",
      component: "text",
      required: false,
    },
    0,
  );

  assert.equal(field.visible_when, undefined);
});

void test("normalizeParameterField: visible_when with numeric value is preserved", () => {
  const field = normalizeParameterField(
    {
      field_key: "testField",
      label: "Test",
      component: "text",
      required: false,
      visible_when: {
        field: "count",
        op: "eq",
        value: 5,
      },
    },
    0,
  );

  assert.ok(field.visible_when !== undefined);
  assert.equal(field.visible_when.op, "eq");
  assert.equal(field.visible_when.value, 5);
});

void test("normalizeParameterField: visible_when with boolean value is preserved", () => {
  const field = normalizeParameterField(
    {
      field_key: "testField",
      label: "Test",
      component: "text",
      required: false,
      visible_when: {
        field: "enabled",
        op: "eq",
        value: true,
      },
    },
    0,
  );

  assert.ok(field.visible_when !== undefined);
  assert.equal(field.visible_when.op, "eq");
  assert.equal(field.visible_when.value, true);
});

void test("normalizeParameterField: visible_when camelCase (visibleWhen) is also supported", () => {
  const field = normalizeParameterField(
    {
      field_key: "testField",
      label: "Test",
      component: "text",
      required: false,
      visibleWhen: {
        field: "imageMode",
        op: "eq",
        value: "reference",
      },
    },
    0,
  );

  assert.ok(field.visible_when !== undefined);
  assert.equal(field.visible_when.field, "imageMode");
  assert.equal(field.visible_when.op, "eq");
  assert.equal(field.visible_when.value, "reference");
});
