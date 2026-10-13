import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// guard:button-standard 夹具自测：mkdtemp 夹具 + spawnSync(node, [SCRIPT, --root, --policy])
// 断言 exit 0/1。夹具 policy 是测试专用临时文件，不影响真实 policy
// （tooling/policies/button-standard.policy.json）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = path.join(ROOT, 'tooling/scripts/guard-button-standard.mjs');
const REAL_POLICY = path.join(ROOT, 'tooling/policies/button-standard.policy.json');

const EDITOR_SRC = 'apps/editor/src';
const HUB_SRC = 'apps/hub/src';
const UI_SRC = 'packages/ui/src';

// 夹具 policy：与真实 policy 同构（同 zone 口径），豁免清单只保留用例所需条目。
const FIXTURE_POLICY = JSON.stringify({
  spec: 'docs/ui-button-standard.md',
  tsxZones: [HUB_SRC, EDITOR_SRC],
  btn004Zone: EDITOR_SRC,
  ignorePaths: ['node_modules/**', '**/dist/**'],
  btn001: {
    forbiddenTokenPatterns: [
      '^h-\\d',
      '^h-\\[',
      '^px-\\[',
      '^py-\\[',
      '^text-\\[',
      '^text-2xs$',
      '^rounded-full$',
      '^size-',
    ],
    exemptions: [
      {
        file: `${EDITOR_SRC}/geometry-exempt.tsx`,
        allowedTokens: ['h-6', 'size-7'],
        note: '夹具豁免：登记 token 放行，登记外 token 仍报红',
      },
    ],
  },
  btn002: {
    whitelist: [
      {
        file: `${EDITOR_SRC}/native-whitelisted.tsx`,
        condition: '②',
        note: '夹具白名单：宿主场景完整定义的局部控件',
      },
      {
        file: `${EDITOR_SRC}/legacy-exempt.tsx`,
        condition: '§10 登记例外',
        note: '夹具白名单：BTN-004 例外文件同时是 BTN-002 登记文件（对应真实 AssetNodeChrome.tsx）',
      },
    ],
  },
  btn003: {
    exemptions: [
      {
        file: `${EDITOR_SRC}/dynamic-variant-exempt.tsx`,
        note: '夹具豁免：条件 variant 二元切换',
      },
    ],
  },
  btn004: {
    banned: ['usage-btn', 'tool-btn', 'task-cancel', 'confirm-fill'],
    exceptions: [
      {
        names: ['usage-btn', 'confirm-fill'],
        files: [`${EDITOR_SRC}/legacy-exempt.tsx`, `${EDITOR_SRC}/legacy.css`],
        note: '夹具例外：§10 登记例外原样保留',
      },
    ],
  },
});

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'button-standard-'));
  const policyPath = path.join(root, 'button-standard.policy.json');
  fs.writeFileSync(policyPath, FIXTURE_POLICY);
  return { root, policyPath };
};

const cleanup = (root) => {
  fs.rmSync(root, { recursive: true, force: true });
};

const runGuard = (root, policyPath) =>
  spawnSync(process.execPath, [SCRIPT, '--root', root, '--policy', policyPath], {
    cwd: root,
    encoding: 'utf8',
  });

const writeEditorFile = (root, relPath, content) =>
  writeFile(path.join(root, EDITOR_SRC, relPath), content);

test('合法：仅用 size prop 与布局参与类的 Button 通过', () => {
  // @spec: BTN-001
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'clean.tsx',
      `export const C = () => (\n  <Button size="icon-sm" variant="ghost" className="h-auto min-h-0 w-full flex-1 justify-start">\n    ok\n  </Button>\n);\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /checked 1 files/);
  } finally {
    cleanup(root);
  }
});

test('非法：className 高度类 h-<数字> 报红并给出文件与行号', () => {
  // @spec: BTN-001
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'features/row/Row.tsx',
      `export const C = () => (\n  <Button size="sm" className="h-6 px-1.5">x</Button>\n);\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /features\/row\/Row\.tsx:2 -> BTN-001/);
    assert.match(result.stderr, /h-6/);
  } finally {
    cleanup(root);
  }
});

test('非法：h-[..] 任意值、text-2xs、rounded-full、size-* 均报红（cn 组合与响应式前缀）', () => {
  // @spec: BTN-001
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'a.tsx',
      `export const A = () => <Button className={cn("md:h-[40px]", cond && "text-2xs")} />;\nexport const B = () => <Button className="rounded-full" />;\nexport const D = () => <Button className="size-8 p-0" />;\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /h-\[40px\]/);
    assert.match(result.stderr, /text-2xs/);
    assert.match(result.stderr, /rounded-full/);
    assert.match(result.stderr, /size-8/);
  } finally {
    cleanup(root);
  }
});

test('豁免：policy 登记文件与 token 放行，登记外 token 仍报红', () => {
  // @spec: BTN-001
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'geometry-exempt.tsx',
      `export const A = () => <Button className="h-6" />;\nexport const B = () => <Button className="size-7" />;\n`,
    );
    writeEditorFile(
      root,
      'geometry-exempt-leak.tsx',
      `export const C = () => <Button className="h-6 text-[11px]" />;\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /geometry-exempt-leak\.tsx:1 -> BTN-001/);
    assert.match(result.stderr, /text-\[11px\]/);
    assert.doesNotMatch(result.stderr, /geometry-exempt\.tsx/);
  } finally {
    cleanup(root);
  }
});

test('非法：原生 <button> 未登记白名单报红', () => {
  // @spec: BTN-002
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'features/canvas/Overlay.tsx',
      `export const C = () => (\n  <button type="button" className="h-6 w-6" aria-label="x">x</button>\n);\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /features\/canvas\/Overlay\.tsx:2 -> BTN-002/);
  } finally {
    cleanup(root);
  }
});

test('豁免：白名单文件的原生按钮放行；packages/ui 包内实现天然合法', () => {
  // @spec: BTN-002
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'native-whitelisted.tsx',
      `export const C = () => <button type="button">x</button>;\n`,
    );
    writeFile(
      path.join(root, UI_SRC, 'chip.tsx'),
      `export const C = () => <button type="button">x</button>;\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('非法：variant/size 字面量越枚举报红（拦截 default/xs 复活）', () => {
  // @spec: BTN-003
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'legacy.tsx',
      `export const A = () => <Button variant="default">x</Button>;\nexport const B = () => <Button size="xs">x</Button>;\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /legacy\.tsx:1 -> BTN-003: variant 字面量 "default"/);
    assert.match(result.stderr, /legacy\.tsx:2 -> BTN-003: size 字面量 "xs"/);
  } finally {
    cleanup(root);
  }
});

test('合法：枚举内字面量通过', () => {
  // @spec: BTN-003
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'clean.tsx',
      `export const A = () => <Button variant="ghost-destructive" size="2xs">x</Button>;\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('非法：非字面量 variant 未豁免报红；豁免文件放行', () => {
  // @spec: BTN-003
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'dynamic.tsx',
      `export const C = ({ danger }: { danger: boolean }) => (\n  <Button variant={danger ? 'destructive' : 'primary'}>x</Button>\n);\n`,
    );
    writeEditorFile(
      root,
      'dynamic-variant-exempt.tsx',
      `export const C = ({ open }: { open: boolean }) => (\n  <Button variant={open ? 'secondary' : 'ghost'}>x</Button>\n);\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dynamic\.tsx:2 -> BTN-003: variant 非字面量/);
    assert.doesNotMatch(result.stderr, /dynamic-variant-exempt\.tsx/);
  } finally {
    cleanup(root);
  }
});

test('非法：buttonVariants({ variant }) 调用形态同口径扫描', () => {
  // @spec: BTN-003
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'variants.ts',
      `import { buttonVariants } from "@iart/ui";\nexport const legacy = buttonVariants({ variant: "default" });\nexport const dynamic = buttonVariants({ variant: danger ? "destructive" : "primary" });\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /variants\.ts:2 -> BTN-003: variant 字面量 "default"/);
    assert.match(result.stderr, /variants\.ts:3 -> BTN-003: variant 非字面量/);
  } finally {
    cleanup(root);
  }
});

test('非法：banned 私有按钮类出现在新文件报红（tsx 与 css）', () => {
  // @spec: BTN-004
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'features/new/NewCard.tsx',
      `export const C = () => <button type="button" className="usage-btn">x</button>;\n`,
    );
    writeEditorFile(
      root,
      'app/new.css',
      `.tool-btn { background: red; }\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /NewCard\.tsx:1 -> BTN-004: 私有按钮类\/常量 "usage-btn"/);
    assert.match(result.stderr, /new\.css:1 -> BTN-004: 私有按钮类\/常量 "tool-btn"/);
  } finally {
    cleanup(root);
  }
});

test('豁免：例外文件放行；注释提及与近名 token（task-cancelled）不误报', () => {
  // @spec: BTN-004
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'legacy-exempt.tsx',
      `// 注释：usage-btn 已退役，此文件为 §10 例外登记文件。\nexport const C = () => <button type="button" className="usage-btn confirm-fill">x</button>;\n`,
    );
    writeEditorFile(
      root,
      'legacy.css',
      `/* .usage-btn.confirm-fill 填充规则（§10 登记例外） */\n.usage-btn.confirm-fill { background: #b91c1c; color: white; }\n`,
    );
    writeEditorFile(
      root,
      'boundary.tsx',
      `const note = 'task-cancelled-note';\nconst contract = 'task-cancel-contract';\nexport const C = () => <div className="task-cancelled-note">x</div>;\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 0);
  } finally {
    cleanup(root);
  }
});

test('排除：__tests__ 与 *.test.* 不扫描；扫描根外（packages/ui、hub 白名单外 hub 文件按 BTN-001 照扫）', () => {
  // @spec: BTN-002
  const { root, policyPath } = createFixture();
  try {
    writeEditorFile(
      root,
      'features/canvas/__tests__/a.test.tsx',
      `export const t = () => <button type="button">x</button>;\n`,
    );
    writeEditorFile(
      root,
      'features/canvas/b.test.tsx',
      `export const t = () => <button type="button">x</button>;\n`,
    );
    const result = runGuard(root, policyPath);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /checked 0 files/);
  } finally {
    cleanup(root);
  }
});

test('默认 policy：省略 --policy 时回退到脚本相对路径的真实 policy', () => {
  // @spec: BTN-002
  const { root } = createFixture();
  try {
    writeEditorFile(
      root,
      'features/canvas/Overlay.tsx',
      `export const C = () => <button type="button">x</button>;\n`,
    );
    const result = spawnSync(process.execPath, [SCRIPT, '--root', root], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BTN-002/);
  } finally {
    cleanup(root);
  }
});

test('真实 policy 可解析且登记面覆盖当前仓库：对真实仓库全量跑应零违规', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', ROOT, '--policy', REAL_POLICY], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `真实仓库应零违规：\n${result.stderr}`);
  assert.match(result.stdout, /checked \d+ files/);
});
