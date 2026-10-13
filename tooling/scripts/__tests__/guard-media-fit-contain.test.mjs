import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'tooling/scripts/guard-media-fit-contain.mjs');

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const runGuard = (root) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root], {
    cwd: root,
    encoding: 'utf8',
  });

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-fit-contain-'));
  return root;
};

const cleanup = (root) => {
  fs.rmSync(root, { recursive: true, force: true });
};

test('合法：img 直挂定高 flex 容器（max-h-full 生效）通过', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"><img className="block max-h-full max-w-full object-contain" /></div>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /checked 1 JSX files/);
  } finally {
    cleanup(root);
  }
});

test('合法：MediaStageFitBox 显式像素盒内 img h-full 通过', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <MediaStageFitBox naturalWidth={100} naturalHeight={100}><img className="block h-full w-full object-contain" /></MediaStageFitBox>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('非法：img max-h-full 包在 inline-block wrapper 下报错', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <div className="relative inline-block select-none"><img className="block max-h-full max-w-full object-contain" /></div>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /comp\.tsx:1 <img>/);
  } finally {
    cleanup(root);
  }
});

test('非法：next Image 元素（非自闭合）同样被捕获', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <div className="inline-block"><Image className="block max-h-full" src="a" alt="a">{null}</Image></div>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /<Image>/);
  } finally {
    cleanup(root);
  }
});

test('非法：cn() 组合类名中的 inline-block + max-h-full 被捕获', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `const cn = (...a: string[]) => a.join(" ");\nexport const C = () => <div className={cn("relative", "inline-block", "select-none")}><video className={cn("block", "max-h-full")} /></div>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /<video>/);
  } finally {
    cleanup(root);
  }
});

test('非法：嵌套两层后 inline-block 祖先仍生效', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <div className="inline-block"><div className="p-2"><canvas className="max-h-[100%]" /></div></div>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /<canvas>/);
  } finally {
    cleanup(root);
  }
});

test('合法：inline-block 下媒体用显式像素尺寸（无百分比 max-height）通过', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `export const C = () => <div className="inline-block"><img className="block max-h-20 max-w-20 object-contain" /></div>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('豁免：死代码 vendored 目录不扫描', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'apps/editor/src/components/ai-elements/dead.tsx'),
      `export const C = () => <div className="inline-block"><img className="max-h-full" /></div>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});
