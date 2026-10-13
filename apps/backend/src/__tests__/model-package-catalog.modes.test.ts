import assert from "node:assert/strict";
import test from "node:test";

import { normalizeModes } from "../local-server/model-package-catalog.projection.cts";

const getOverride = (
  modes: CatalogMode[] | undefined,
  modeIndex: number,
  fieldKey: string,
) => {
  if (!modes) return undefined;
  const mode = modes[modeIndex];
  if (!mode) return undefined;
  return mode["parameter_overrides"][fieldKey];
};

import type { CatalogMode } from "../local-server/model-package-catalog.types.cts";

void test("normalizeModes: valid modes array is parsed correctly", () => {
  const modes = normalizeModes([
    {
      key: "simple",
      label: "Simple Mode",
      parameter_overrides: {
        resolution: { visibility: "hidden" },
        seed: { visibility: "hidden" },
      },
    },
    {
      key: "advanced",
      label: "Advanced Mode",
      parameter_overrides: {
        resolution: { visibility: "visible", required: true },
        seed: { visibility: "visible" },
      },
    },
  ]);

  assert.ok(modes !== undefined);
  if (!modes) return;
  assert.equal(modes.length, 2);
  const first = modes[0];
  const second = modes[1];
  if (!first || !second) { assert.fail("modes should have two entries"); return; }
  assert.equal(first.key, "simple");
  assert.equal(first.label, "Simple Mode");
  const firstRes = getOverride(modes, 0, "resolution");
  assert.equal(firstRes !== undefined && firstRes !== null ? firstRes["visibility"] : undefined, "hidden");
  assert.equal(second.key, "advanced");
  const secondRes = getOverride(modes, 1, "resolution");
  assert.equal(secondRes !== undefined && secondRes !== null ? secondRes["visibility"] : undefined, "visible");
  assert.equal(secondRes !== undefined && secondRes !== null ? secondRes["required"] : undefined, true);
});

void test("normalizeModes: undefined input returns undefined", () => {
  assert.equal(normalizeModes(undefined), undefined);
});

void test("normalizeModes: non-array input returns undefined", () => {
  assert.equal(normalizeModes("not an array"), undefined);
  assert.equal(normalizeModes({}), undefined);
  assert.equal(normalizeModes(42), undefined);
});

void test("normalizeModes: empty array returns undefined", () => {
  assert.equal(normalizeModes([]), undefined);
});

void test("normalizeModes: item missing key is skipped", () => {
  const modes = normalizeModes([
    { label: "No Key", parameter_overrides: {} },
    { key: "valid", label: "Valid", parameter_overrides: {} },
  ]);

  assert.ok(modes !== undefined);
  if (!modes) return;
  assert.equal(modes.length, 1);
  const entry = modes[0];
  if (!entry) { assert.fail("expected one entry"); return; }
  assert.equal(entry.key, "valid");
});

void test("normalizeModes: item missing label is skipped", () => {
  const modes = normalizeModes([
    { key: "noLabel", parameter_overrides: {} },
  ]);

  assert.equal(modes, undefined);
});

void test("normalizeModes: item missing parameter_overrides is skipped", () => {
  const modes = normalizeModes([
    { key: "noOverrides", label: "No Overrides" },
  ]);

  assert.equal(modes, undefined);
});

void test("normalizeModes: parameter_overrides with default_value is preserved", () => {
  const modes = normalizeModes([
    {
      key: "mode1",
      label: "Mode 1",
      parameter_overrides: {
        quality: { default_value: "high" },
      },
    },
  ]);

  assert.ok(modes !== undefined);
  if (!modes) return;
  const entry = modes[0];
  if (!entry) { assert.fail("expected one entry"); return; }
  const quality = getOverride(modes, 0, "quality");
  assert.equal(quality !== undefined && quality !== null ? quality["default_value"] : undefined, "high");
});

void test("normalizeModes: non-object item in array is skipped", () => {
  const modes = normalizeModes([
    "not-an-object",
    { key: "valid", label: "Valid", parameter_overrides: { field1: { visibility: "visible" } } },
  ]);

  assert.ok(modes !== undefined);
  if (!modes) return;
  assert.equal(modes.length, 1);
  const entry = modes[0];
  if (!entry) { assert.fail("expected one entry"); return; }
  assert.equal(entry.key, "valid");
});

void test("normalizeModes: invalid visibility value is ignored", () => {
  const modes = normalizeModes([
    {
      key: "mode1",
      label: "Mode 1",
      parameter_overrides: {
        field1: { visibility: "invalid" },
      },
    },
  ]);

  assert.ok(modes !== undefined);
  if (!modes) return;
  const field1 = getOverride(modes, 0, "field1");
  assert.equal(field1 !== undefined && field1 !== null ? field1["visibility"] : undefined, undefined);
});

void test("normalizeModes: camelCase parameterOverrides is also supported", () => {
  const modes = normalizeModes([
    {
      key: "mode1",
      label: "Mode 1",
      parameterOverrides: {
        field1: { visibility: "hidden" },
      },
    },
  ]);

  assert.ok(modes !== undefined);
  if (!modes) return;
  const field1 = getOverride(modes, 0, "field1");
  assert.equal(field1 !== undefined && field1 !== null ? field1["visibility"] : undefined, "hidden");
});

void test("normalizeModes: modes without valid entries returns undefined (backward compat)", () => {
  // All items are invalid, so result is undefined (same as not having modes at all)
  const modes = normalizeModes([
    { label: "No Key" },
    { key: "noLabel" },
    "not-an-object",
  ]);
  assert.equal(modes, undefined);
});

void test("normalizeModes: modes array with only invalid overrides is still valid (backward compat)", () => {
  // A mode with empty parameter_overrides is still valid
  const modes = normalizeModes([
    {
      key: "empty",
      label: "Empty Mode",
      parameter_overrides: {},
    },
  ]);

  assert.ok(modes !== undefined);
  if (!modes) return;
  assert.equal(modes.length, 1);
  const entry = modes[0];
  if (!entry) { assert.fail("expected one entry"); return; }
  assert.equal(entry.key, "empty");
  assert.equal(Object.keys(entry["parameter_overrides"]).length, 0);
});
