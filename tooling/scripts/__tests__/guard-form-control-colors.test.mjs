import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'tooling/scripts/guard-form-control-colors.mjs');

const SHARED_CONTROLS = {
  'packages/ui/src/input.tsx':
    '<input data-slot="input" className="text-foreground placeholder:text-muted-foreground" />\n',
  'packages/ui/src/textarea.tsx':
    '<textarea data-slot="textarea" className="text-foreground placeholder:text-muted-foreground" />\n',
  'packages/ui/src/select.tsx':
    '<button data-slot="select-trigger" className="text-foreground data-[placeholder]:text-muted-foreground" />\n',
  'packages/ui/src/command.tsx':
    '<input data-slot="command-input" className="text-foreground placeholder:text-muted-foreground" />\n',
};

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const createRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'form-control-colors-'));
  writeFile(
    path.join(root, 'policy.json'),
    JSON.stringify(
      {
        zones: ['src'],
        boundaryZones: [],
        fileExtensions: ['.ts', '.tsx'],
        ignorePaths: ['**/node_modules/**', '**/dist/**'],
      },
      null,
      2,
    ),
  );
  for (const [relPath, content] of Object.entries(SHARED_CONTROLS)) {
    writeFile(path.join(root, relPath), content);
  }
  return root;
};

const runGate = (root) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root, '--policy', 'policy.json'], {
    cwd: root,
    encoding: 'utf8',
  });

test('FC-002：浅色容器包裹控件先红，标签与控件改为兄弟后转绿', () => {
  const root = createRoot();
  const target = path.join(root, 'src/Field.tsx');
  writeFile(
    target,
    `export const Field = ({ Input }: { Input: () => unknown }) => (
  <label className="flex flex-col gap-1 text-muted-foreground">
    名称
    <Input />
  </label>
);
`,
  );

  const red = runGate(root);
  assert.notEqual(red.status, 0, `Expected exit 1, got ${red.status}\n${red.stderr}`);
  assert.match(red.stderr, /FC-002/);
  assert.match(red.stderr, /src\/Field\.tsx/);

  writeFile(
    target,
    `export const Field = ({ Input }: { Input: () => unknown }) => (
  <div className="flex flex-col gap-1">
    <label className="text-muted-foreground">名称</label>
    <Input />
  </div>
);
`,
  );
  const green = runGate(root);
  assert.equal(green.status, 0, `Expected exit 0, got ${green.status}\n${green.stderr}`);
});

test('FC-002：控件自身用 text-muted-foreground 覆盖前景色即红', () => {
  const root = createRoot();
  writeFile(
    path.join(root, 'src/Field.tsx'),
    'export const Field = () => <input className="text-muted-foreground" />;\n',
  );

  const red = runGate(root);
  assert.notEqual(red.status, 0, `Expected exit 1, got ${red.status}\n${red.stderr}`);
  assert.match(red.stderr, /FC-002/);
});

test('FC-003：占位色加透明度先红，改回 muted-foreground 原值后转绿', () => {
  const root = createRoot();
  const target = path.join(root, 'src/Field.tsx');
  writeFile(
    target,
    'export const Field = () => <input className="placeholder:text-muted-foreground/70" />;\n',
  );

  const red = runGate(root);
  assert.notEqual(red.status, 0, `Expected exit 1, got ${red.status}\n${red.stderr}`);
  assert.match(red.stderr, /FC-003/);

  writeFile(
    target,
    'export const Field = () => <input className="placeholder:text-muted-foreground" />;\n',
  );
  const green = runGate(root);
  assert.equal(green.status, 0, `Expected exit 0, got ${green.status}\n${green.stderr}`);
});

test('FC-001：共享控件未钉死 text-foreground 即红', () => {
  const root = createRoot();
  writeFile(
    path.join(root, 'packages/ui/src/input.tsx'),
    '<input data-slot="input" className="placeholder:text-muted-foreground" />\n',
  );

  const red = runGate(root);
  assert.notEqual(red.status, 0, `Expected exit 1, got ${red.status}\n${red.stderr}`);
  assert.match(red.stderr, /FC-001/);
  assert.match(red.stderr, /text-foreground/);
});
