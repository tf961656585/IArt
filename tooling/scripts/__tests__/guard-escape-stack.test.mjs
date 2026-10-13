import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'tooling/scripts/guard-escape-stack.mjs');

const EDITOR_SRC = 'apps/editor/src';
const HUB_SRC = 'apps/hub/src';
const UI_SRC = 'packages/ui/src';

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const runGuard = (root) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root], {
    cwd: root,
    encoding: 'utf8',
  });

const createFixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'escape-stack-'));

const cleanup = (root) => {
  fs.rmSync(root, { recursive: true, force: true });
};

const writeEditorFile = (root, relPath, content) =>
  writeFile(path.join(root, EDITOR_SRC, relPath), content);

test('合法：无 Escape 键判定的业务组件通过', () => {
  const root = createFixture();
  try {
    writeEditorFile(
      root,
      'handler.tsx',
      `export const handler = (event: KeyboardEvent) => {\n  if (event.key === 'Enter') return;\n  return event.key.toLowerCase();\n};\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /checked 1 files/);
  } finally {
    cleanup(root);
  }
});

test('非法：event.key === Escape 报错并给出路径与行号', () => {
  // @spec: OVL-009
  const root = createFixture();
  try {
    writeEditorFile(
      root,
      'features/rightworkspace/RightWorkspace.tsx',
      `export const onKeyDown = (event: KeyboardEvent) => {\n  void 0;\n  if (event.key !== 'Escape') return;\n};\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /apps\/editor\/src\/features\/rightworkspace\/RightWorkspace\.tsx:3/,
    );
    assert.match(result.stderr, /Escape 字面量比较：!== 'Escape'/);
  } finally {
    cleanup(root);
  }
});

test('非法：event.code === Escape 与字面量在左的比较均报错', () => {
  const root = createFixture();
  try {
    writeEditorFile(
      root,
      'a.ts',
      `export const isEscapeCode = (event: KeyboardEvent) => event.code === 'Escape';\nexport const isEscapeKey = (key: string) => 'Escape' === key;\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.equal((result.stderr.match(/Escape 字面量比较/g) ?? []).length, 2);
  } finally {
    cleanup(root);
  }
});

test('非法：小写字面量 key.toLowerCase() === escape 报错', () => {
  const root = createFixture();
  try {
    writeEditorFile(
      root,
      'a.ts',
      `export const isEscape = (event: KeyboardEvent) => event.key.toLowerCase() === 'escape';\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /=== 'escape'/);
  } finally {
    cleanup(root);
  }
});

test('非法：keyCode 与 27 的比较（双向）报错', () => {
  const root = createFixture();
  try {
    writeEditorFile(
      root,
      'a.ts',
      `export const byKeyCode = (event: KeyboardEvent) => event.keyCode === 27;\nexport const byReverse = (event: KeyboardEvent) => 27 === event.keyCode;\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.equal((result.stderr.match(/keyCode 27 判定/g) ?? []).length, 2);
  } finally {
    cleanup(root);
  }
});

test('非法：switch 标签 case Escape 报错', () => {
  const root = createFixture();
  try {
    writeEditorFile(
      root,
      'a.ts',
      `export const reduce = (key: string) => {\n  switch (key) {\n    case 'Escape':\n      return 'close';\n    default:\n      return 'none';\n  }\n};\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /a\.ts:3/);
    assert.match(result.stderr, /case 'Escape'/);
  } finally {
    cleanup(root);
  }
});

test('非法：onEscapeKeyDown 透传与 onEscape 回调声明报错', () => {
  const root = createFixture();
  try {
    writeEditorFile(
      root,
      'SaveCharacterDialog.tsx',
      `export const C = () => <DialogContent onEscapeKeyDown={(event) => event.preventDefault()} />;\n`,
    );
    writeEditorFile(
      root,
      'handler.ts',
      `export const useLocalEscape = (onEscape: () => void) => onEscape;\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SaveCharacterDialog\.tsx:1 -> onEscape\* 回调：onEscapeKeyDown/);
    assert.match(result.stderr, /handler\.ts:1 -> onEscape\* 回调：onEscape/);
  } finally {
    cleanup(root);
  }
});

test('合法：注释中的旧写法被剥离，不误报', () => {
  const root = createFixture();
  try {
    writeEditorFile(
      root,
      'a.ts',
      `// 旧实现：if (event.key === 'Escape') return;\n/**\n * 迁移前用 onEscapeKeyDown 就地拦截，已退役。\n */\nexport const noop = () => 0;\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /checked 1 files/);
  } finally {
    cleanup(root);
  }
});

test('合法：日志/展示字符串与类型字面量不误报', () => {
  const root = createFixture();
  try {
    writeEditorFile(
      root,
      'a.tsx',
      `export type Key = 'Escape' | 'Enter';\nexport const log = () => console.log('Escape pressed');\nexport const C = () => <div data-testid="escape" aria-label="Escape" />;\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('合法：层配置字段 closeOnEscape 不误报', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, UI_SRC, 'overlay-consumer.tsx'),
      `import { useOverlayLayer } from './overlay-stack';\nexport const C = () => {\n  useOverlayLayer({ active: true, id: 'x', onClose: () => undefined, closeOnEscape: false });\n  return null;\n};\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('扫描根：Hub 与 packages/ui 同样纳入扫描', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, HUB_SRC, 'hubEscape.ts'),
      `export const isEscape = (key: string) => key === 'Escape';\n`,
    );
    writeFile(
      path.join(root, UI_SRC, 'uiEscape.ts'),
      `export const isEscape = (key: string) => key === 'Escape';\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /apps\/hub\/src\/hubEscape\.ts:1/);
    assert.match(result.stderr, /packages\/ui\/src\/uiEscape\.ts:1/);
  } finally {
    cleanup(root);
  }
});

test('豁免：packages/ui/src/overlay-stack 分发器事实源不扫描', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, UI_SRC, 'overlay-stack/dispatcher.ts'),
      `export const handle = (event: KeyboardEvent) => {\n  if (event.key !== 'Escape') return false;\n  if (event.keyCode === 27) return false;\n  return true;\n};\n`,
    );
    writeFile(
      path.join(root, UI_SRC, 'overlay-stack/useOverlayLayer.ts'),
      `export const onEscapeKeyDown = () => undefined;\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /checked 0 files/);
  } finally {
    cleanup(root);
  }
});

test('豁免：行内 guard-escape-stack-exempt 标记跳过该行', () => {
  const root = createFixture();
  try {
    writeEditorFile(
      root,
      'legacy.ts',
      `// 临时遗留：右栏迁移尚未完成，随右侧工作区栈化一并删除。\nexport const legacy = (event: KeyboardEvent) => event.key === 'Escape'; // guard-escape-stack-exempt\nexport const keep = (event: KeyboardEvent) => event.key === 'Escape';\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.equal((result.stderr.match(/Escape 字面量比较/g) ?? []).length, 1);
    assert.match(result.stderr, /legacy\.ts:3/);
    assert.doesNotMatch(result.stderr, /legacy\.ts:2/);
  } finally {
    cleanup(root);
  }
});

test('不扫描：__tests__ 目录与 *.test.* 文件', () => {
  const root = createFixture();
  try {
    writeEditorFile(
      root,
      'features/canvas/__tests__/a.test.tsx',
      `export const t = () => 'Escape' === 'Escape';\n`,
    );
    writeEditorFile(
      root,
      'features/canvas/b.test.ts',
      `export const t = () => 'Escape' === 'Escape';\n`,
    );
    writeEditorFile(
      root,
      'features/canvas/__tests__/helper.ts',
      `export const t = () => 'Escape' === 'Escape';\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /checked 0 files/);
  } finally {
    cleanup(root);
  }
});

test('不扫描：扫描根外路径与守卫/原型豁免路径', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'apps/backend/src/a.ts'),
      `export const t = () => 'Escape' === 'Escape';\n`,
    );
    writeFile(
      path.join(root, 'apps/editor/src-extra/a.ts'),
      `export const t = () => 'Escape' === 'Escape';\n`,
    );
    writeFile(
      path.join(root, 'prototypes/shared/escape.ts'),
      `export const t = () => 'Escape' === 'Escape';\n`,
    );
    writeFile(
      path.join(root, 'tooling/scripts/fixture.ts'),
      `export const t = () => 'Escape' === 'Escape';\n`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /checked 0 files/);
  } finally {
    cleanup(root);
  }
});
