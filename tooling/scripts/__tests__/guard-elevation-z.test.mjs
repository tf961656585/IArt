import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'tooling/scripts/guard-elevation-z.mjs');

import { fileURLToPath } from 'node:url';

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const runGuard = (root) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root], {
    cwd: root,
    encoding: 'utf8',
  });

const createFixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elevation-z-'));

const cleanup = (root) => {
  fs.rmSync(root, { recursive: true, force: true });
};

test('合法：语义令牌 className 与 var(--z-index-*) CSS 通过', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <div className="z-dock"><div className="z-modal" /></div>;`,
    );
    writeFile(
      path.join(root, 'style.css'),
      `.a { position: absolute; z-index: var(--z-index-canvas-chrome); }`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /checked 2 files/);
  } finally {
    cleanup(root);
  }
});

test('合法：局部叠层白名单 z-0/z-10/z-20/-z-10 通过', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <div className="z-10"><span className="-z-10" /><span className="z-20" /></div>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('合法：CSS 小整数（节点内部叠层 ≤6）与 -1（沉底惯例）通过', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'style.css'),
      `.badge { z-index: 5; }\n.hatch { z-index: 1; }\n.sink { z-index: -1; }`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('合法：具名常量与表达式 zIndex 引用通过', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `const MARQUEE_Z_INDEX = 30;\nexport const C = (m) => <div style={{ zIndex: MARQUEE_Z_INDEX, zIndex2: undefined }} data-x={m.map((n, i) => ({ zIndex: i }))} />;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('非法：className 数字散值 z-[120] 报错', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <div className="z-[120]">bad</div>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /z-\[120\]/);
  } finally {
    cleanup(root);
  }
});

test('非法：预设档 z-50 报错', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <div className="fixed z-50">bad</div>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /z-50/);
  } finally {
    cleanup(root);
  }
});

test('非法：CSS z-index 大整数报错', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'style.css'),
      `.modal { z-index: 1300; }`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /z-index: 1300/);
  } finally {
    cleanup(root);
  }
});

test('非法：内联 style zIndex 裸数字报错', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <div style={{ position: 'absolute', zIndex: 1400 }} />;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /z-index: 1400/);
  } finally {
    cleanup(root);
  }
});

test('合法：类型注解 zIndex: number 不误报', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'types.ts'),
      `export type Entry = { groupId: string; zIndex: number; };`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('豁免：行内 guard-elevation-z-exempt 标记跳过该行', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <div className="z-[120]">legacy</div>; // guard-elevation-z-exempt`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('豁免：prototypes/ 与令牌定义文件不扫描', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'prototypes/shared/composer.css'),
      `.popover { z-index: 200; }`,
    );
    writeFile(
      path.join(root, 'packages/ui/src/elevation.css'),
      `@theme { --z-index-dock: 120; }`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
    // 只剩空目录无文件
    assert.match(result.stdout, /checked 0 files/);
  } finally {
    cleanup(root);
  }
});

test('语义令牌不被误判：z-dock/z-modal/z-popover 均通过', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <div className={["z-dock z-modal z-popover z-tooltip z-feedback z-drawer z-dock-popover z-canvas-banner z-canvas-chrome z-canvas-overlay z-surface-inner"].join(" ")} />;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});
