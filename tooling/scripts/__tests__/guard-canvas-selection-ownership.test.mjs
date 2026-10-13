import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'tooling/scripts/guard-canvas-selection-ownership.mjs');

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const runGate = (root, policyPath) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root, '--policy', policyPath], {
    cwd: root,
    encoding: 'utf8',
  });

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-selection-ownership-'));
  const policyPath = 'policy.json';
  writeFile(
    path.join(root, policyPath),
    JSON.stringify(
      {
        zones: ['src/stable'],
        boundaryZones: ['src/stable/migration/**'],
        fileExtensions: ['.ts', '.tsx'],
        ignorePaths: [],
      },
      null,
      2,
    ),
  );
  return { root, policyPath };
};

test('detects legacy store selection action access', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/store.ts'),
    `
const selectNodes = useCanvasStore((state) => state.selectNodes);
useCanvasStore.getState().clearSelection();
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  const issues = result.stderr.match(/canvas-selection\/no-legacy-store-selection-access/g) ?? [];
  assert.equal(issues.length, 2, result.stderr);
});

test('detects legacy selected on graph node and graph edge fixtures', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/fixtures.ts'),
    `
const node = {
  id: 'node-1',
  type: 'textInput',
  position: { x: 0, y: 0 },
  data: {},
  inputs: [],
  outputs: [],
  selected: false,
};
const edge = {
  id: 'edge-1',
  source: 'node-1',
  sourcePort: 'out',
  target: 'node-2',
  targetPort: 'in',
  selected: false,
};
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  const issues = result.stderr.match(/canvas-selection\/no-legacy-selected-steady-state/g) ?? [];
  assert.equal(issues.length, 2, result.stderr);
});

test('detects legacy selectedSlotIds in resultArea data fixtures', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/resultArea.ts'),
    `
const node = {
  data: {
    slots: [],
    collapsed: false,
    selectedSlotIds: [],
  },
};
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  const issues = result.stderr.match(/canvas-selection\/no-legacy-result-area-selected-slot-ids/g) ?? [];
  assert.equal(issues.length, 1, result.stderr);
});

test('allows ReactFlow runtime selected payload, layout session selectedSlotIds, and migration boundary', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/runtime.ts'),
    `
const changes = [{ id: 'node-1', type: 'select', selected: true }];
const layout = { items: [], selectedSlotIds: [] };
`,
  );
  writeFile(
    path.join(fixture.root, 'src/stable/migration/legacy.ts'),
    `
const legacyNode = {
  data: {
    slots: [],
    selectedSlotIds: ['slot-1'],
  },
};
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, result.stderr);
});
