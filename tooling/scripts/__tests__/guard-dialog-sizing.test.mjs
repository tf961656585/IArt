import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'tooling/scripts/guard-dialog-sizing.mjs');

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dialog-sizing-'));
  return root;
};

const cleanup = (root) => {
  fs.rmSync(root, { recursive: true, force: true });
};

test('合法：DialogContent 无 className 通过', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nexport const C = () => <DialogContent form="standard" size="compact">ok</DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /checked 1 JSX files/);
  } finally {
    cleanup(root);
  }
});

test('合法：className 仅含视觉样式（bg-transparent/p-0）通过', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nexport const C = () => <DialogContent form="canvas" className="bg-transparent border-none p-0 shadow-none">ok</DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('合法：className 用 cn() 含视觉样式通过', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nconst cn = (...a: any[]) => a.join(" ");\nexport const C = () => <DialogContent form="standard" className={cn("p-0", "border-none")}>ok</DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('非法：className 含 max-w-2xl 报错', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nexport const C = () => <DialogContent form="standard" className="max-w-2xl">bad</DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /max-w-2xl/);
  } finally {
    cleanup(root);
  }
});

test('非法：className 含 h-[90vh] 与 overflow-hidden 报错', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nexport const C = () => <DialogContent form="canvas" className="h-[90vh] overflow-hidden">bad</DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /h-\[90vh\]/);
    assert.match(result.stderr, /overflow-hidden/);
  } finally {
    cleanup(root);
  }
});

test('非法：cn() 中含响应式 sm:max-w-md 报错', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nconst cn = (...a: any[]) => a.join(" ");\nexport const C = () => <DialogContent form="standard" className={cn("sm:max-w-md", "p-0")}>bad</DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sm:max-w-md/);
  } finally {
    cleanup(root);
  }
});

test('非法：w-[min(92vw,900px)] 报错', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nexport const C = () => <DialogContent form="standard" className="w-[min(92vw,900px)]">bad</DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /w-\[min\(92vw,900px\)\]/);
  } finally {
    cleanup(root);
  }
});

test('豁免：dialog.tsx 本身不被扫描', () => {
  const root = createFixture();
  try {
    // 在 apps/editor/src/components/ui/ 下放一个含尺寸类的 dialog.tsx，应被豁免
    writeFile(
      path.join(root, 'apps/editor/src/components/ui/dialog.tsx'),
      `export const DialogContent = ({ className }: any) => <div className="max-w-lg h-full overflow-hidden" />;`,
    );
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nexport const C = () => <DialogContent form="standard" className="p-0">ok</DialogContent>;`,
    );
    const result = runGuard(root);
    // dialog.tsx 豁免，comp.tsx 合法，应通过
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('非法：canvas 形态承载图片缩放预览但缺 fill 报错', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nimport { ZoomableImagePreview } from "./zoomable-image-preview";\nexport const C = () => <DialogContent form="canvas"><ZoomableImagePreview src="a.png" /></DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rendering ZoomableImagePreview without fill/);
    assert.match(result.stderr, /comp\.tsx:3 missing fill/);
  } finally {
    cleanup(root);
  }
});

test('非法：fill={false} 视为未撑满，报错', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nimport { ZoomableImagePreview } from "./zoomable-image-preview";\nexport const C = () => <DialogContent form="canvas" fill={false}><ZoomableImagePreview src="a.png" /></DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing fill/);
  } finally {
    cleanup(root);
  }
});

test('合法：canvas 形态承载图片缩放预览并传 fill 通过', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nimport { ZoomableImagePreview } from "./zoomable-image-preview";\nexport const C = () => <DialogContent form="canvas" fill><ZoomableImagePreview src="a.png" /></DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('合法：fill 由条件表达式表达通过（图片分支撑满）', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nimport { ZoomableImagePreview } from "./zoomable-image-preview";\nconst mediaType = "image";\nexport const C = () => <DialogContent form="canvas" fill={mediaType === "image"}><ZoomableImagePreview src="a.png" /></DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('合法：standard 形态承载图片缩放预览不受本规则约束', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nimport { ZoomableImagePreview } from "./zoomable-image-preview";\nexport const C = () => <DialogContent form="standard" size="compact"><ZoomableImagePreview src="a.png" /></DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('合法：canvas 形态无图片缩放预览时不要求 fill', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nexport const C = () => <DialogContent form="canvas">ok</DialogContent>;`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('嵌套弹窗：只记承载预览的内层 DialogContent 一次', () => {
  const root = createFixture();
  try {
    writeFile(
      path.join(root, 'comp.tsx'),
      `import { DialogContent } from "./dialog";\nimport { ZoomableImagePreview } from "./zoomable-image-preview";\nexport const C = () => (\n  <DialogContent form="canvas">\n    <DialogContent form="canvas">\n      <ZoomableImagePreview src="a.png" />\n    </DialogContent>\n  </DialogContent>\n);`,
    );
    const result = runGuard(root);
    assert.equal(result.status, 1);
    const matches = result.stderr.match(/missing fill/g) ?? [];
    assert.equal(matches.length, 1);
    assert.match(result.stderr, /comp\.tsx:5 missing fill/);
  } finally {
    cleanup(root);
  }
});
