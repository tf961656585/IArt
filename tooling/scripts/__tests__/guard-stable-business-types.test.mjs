import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'tooling/scripts/guard-stable-business-types.mjs');

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-business-types-'));
  const policyPath = 'policy.json';
  writeFile(
    path.join(root, policyPath),
    JSON.stringify(
      {
        stableZones: ['src/stable'],
        boundaryZones: ['src/stable/raw/**', '**/*.test.ts'],
        openMapNames: ['*Map', 'Raw*'],
        allowedRecordAliases: ['RawJsonObject'],
        allowedFixedFieldObjects: ['process.env', 'process.versions', 'import.meta.env', '*.dataset', '*.userData'],
        fileExtensions: ['.ts'],
        ignorePaths: [],
      },
      null,
      2,
    ),
  );
  return { root, policyPath };
};

test('stable zone rejects naked dynamic dictionaries and fixed-field bracket access', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/catalog.ts'),
    `
type CatalogEntry = Record<string, unknown>;
const read = (entry: CatalogEntry) => entry["options"];
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stable\/no-naked-record-string-unknown/);
  assert.match(result.stderr, /stable\/no-fixed-field-bracket-access/);
});

test('boundary zone and open map naming are allowed', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/raw/parser.ts'),
    `
type CatalogEntry = Record<string, unknown>;
const read = (entry: CatalogEntry) => entry["options"];
`,
  );
  writeFile(
    path.join(fixture.root, 'src/stable/maps.ts'),
    `
type RuntimeValueMap = Record<string, unknown>;
const read = (map: RuntimeValueMap, key: string) => map[key];
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, result.stderr);
});

test('stable zone rejects fixed-field bracket access inside calls and access chains', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/access.ts'),
    `
type CatalogEntry = {
  options?: {
    label?: string;
    value?: string;
  };
};
const normalize = (value: unknown) => value;
const readFromCall = (entry: CatalogEntry) => normalize(entry["options"]);
const readFromOptionalCall = (entry: CatalogEntry) => normalize(entry?.["options"]);
const readFromPropertyChain = (entry: CatalogEntry) => entry["options"].value;
const readFromNestedAccess = (entry: CatalogEntry) => entry["options"]["label"];
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  const fixedFieldIssues = result.stderr.match(/stable\/no-fixed-field-bracket-access/g) ?? [];
  assert.ok(fixedFieldIssues.length >= 4, result.stderr);
});

test('stable zone allows dynamic keys and configured environment objects', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/dynamic.ts'),
    `
type CatalogEntry = {
  options?: unknown;
};
const readDynamic = (entry: CatalogEntry, key: string) => entry[key];
const readProcessEnv = () => process.env["NAME"];
const readProcessVersions = () => process.versions["electron"];
const readImportMetaEnv = () => import.meta.env["NAME"];
const readDataset = (element: HTMLElement) => element.dataset["id"];
const readUserData = (mesh: { userData: Record<string, string> }) => mesh.userData["key"];
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.equal(result.status, 0, result.stderr);
});

test('stable zone rejects Record string unknown heritage unless naming marks an open structure', () => {
  const fixture = createFixture();
  writeFile(
    path.join(fixture.root, 'src/stable/heritage.ts'),
    `
interface Foo extends Record<string, unknown> {
  id: string;
}
interface RawFoo extends Record<string, unknown> {
  id: string;
}
`,
  );

  const result = runGate(fixture.root, fixture.policyPath);
  assert.notEqual(result.status, 0);
  const recordIssues = result.stderr.match(/stable\/no-naked-record-string-unknown/g) ?? [];
  assert.equal(recordIssues.length, 1, result.stderr);
});
