import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const guardPath = path.join(__dirname, '..', 'guard-spec-test-linkage.mjs');

const BASE_POLICY = {
  docs: {
    dirs: ['docs'],
    excludeDirNames: ['archive'],
    specTypes: ['spec', 'contract'],
    activeStatuses: ['Active'],
    terminalStatuses: ['Superseded', 'Deprecated', 'Archived'],
  },
  testSuffixes: ['.test.ts', '.test.tsx', '.test.mts', '.test.mjs'],
  excludeGlobs: ['**/node_modules/**', '**/dist/**'],
  entryGlobs: ['apps/x/src/**/__tests__/*.test.ts'],
  seamMock: {
    fileNamePattern: 'seam',
    detect: ['vi.mock('],
    exemptMarker: 'guard-seam-mock-exempt',
    level: 'warning',
  },
};

const writeTree = (root, files) => {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
};

const specDoc = (status, body) => `---\ntype: spec\nstatus: ${status}\n---\n\n# S\n\n${body}\n`;

const runGuard = (root, extraArgs = []) =>
  spawnSync(process.execPath, [guardPath, '--root', root, '--policy', 'policy.json', ...extraArgs], {
    encoding: 'utf8',
  });

test('R1 引用闭包：废弃/退役/未定义三类分类正确并阻断', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-r1-'));
  writeTree(root, {
    'policy.json': JSON.stringify(BASE_POLICY),
    'docs/active.md': specDoc('Active', '#### 验收：T-001 行为一\n\n描述。\n\n#### 废弃：T-003 已翻转不再验收\n\n描述。\n'),
    'docs/superseded.md': specDoc('Superseded', '#### 验收：S-001 旧行为\n\n描述。\n'),
    'docs/no-frontmatter.md': '# 无 frontmatter\n\n#### 验收：NF-001 未纳管\n',
    'apps/x/src/__tests__/good.test.ts': '// @spec: T-001\n',
    'apps/x/src/__tests__/deprecated.test.ts': '// @spec: T-003\n',
    'apps/x/src/__tests__/retired.test.ts': '// @spec: S-001\n',
    'apps/x/src/__tests__/undefined.test.ts': '// @spec: NOPE-1\n',
    'apps/x/src/__tests__/unmanaged.test.ts': '// @spec: NF-001\n',
  });

  const result = runGuard(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[已废弃\] T-003/);
  assert.match(result.stderr, /\[已随 spec 退役\] S-001/);
  assert.match(result.stderr, /\[未定义\] NOPE-1/);
  // 无 frontmatter 的文档不是 Active，其验收 ID 不构成有效集合
  assert.match(result.stderr, /\[未定义\] NF-001/);
  assert.doesNotMatch(result.stderr, /T-001 ←/);
});

test('R1 干净夹具通过且输出覆盖读数', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-clean-'));
  writeTree(root, {
    'policy.json': JSON.stringify(BASE_POLICY),
    'docs/active.md': specDoc('Active', '#### 验收：T-001 行为一\n\n#### 验收：T-002 行为二\n'),
    'apps/x/src/__tests__/good.test.ts': '// @spec: T-001, T-002\n',
    'apps/x/src/__tests__/plain.test.ts': "test('pure implementation detail', () => {});\n",
  });

  const result = runGuard(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Active 验收 ID 2/);
  assert.match(result.stdout, /标注覆盖 2 个验收 ID/);
  assert.match(result.stdout, /无标注测试文件 1 个/);
});

test('R2 同一 ID 在两份 Active 产物定义即阻断；终态重号仅提示', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-r2-'));
  writeTree(root, {
    'policy.json': JSON.stringify(BASE_POLICY),
    'docs/active-a.md': specDoc('Active', '#### 验收：T-001 A 侧\n'),
    'docs/active-b.md': specDoc('Active', '#### 验收：T-001 B 侧\n\n#### 验收：T-002 正常项\n'),
    'docs/superseded.md': specDoc('Superseded', '#### 验收：T-002 旧口径\n'),
    'apps/x/src/__tests__/good.test.ts': '// @spec: T-002\n',
  });

  const result = runGuard(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /R2 ID T-001 在 2 份 Active 产物中重复定义/);
  assert.match(result.stdout, /\[warn\] R2 ID T-002 终态与 Active 重号/);
});

test('R4 entryGlobs 未覆盖的测试文件报孤儿', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-r4-'));
  writeTree(root, {
    'policy.json': JSON.stringify(BASE_POLICY),
    'docs/active.md': specDoc('Active', '#### 验收：T-001 行为一\n'),
    'apps/x/src/__tests__/covered.test.ts': '// @spec: T-001\n',
    'apps/x/src/__tests__/orphan.test.mts': "test('never executed by any runner', () => {});\n",
  });

  const result = runGuard(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[warn\] R4 孤儿测试文件 1 个/);
  assert.match(result.stdout, /orphan\.test\.mts/);
});

test('R5 skip/todo 输出清单', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-r5-'));
  writeTree(root, {
    'policy.json': JSON.stringify(BASE_POLICY),
    'docs/active.md': specDoc('Active', '#### 验收：T-001 行为一\n'),
    'apps/x/src/__tests__/good.test.ts': '// @spec: T-001\n',
    'apps/x/src/__tests__/sleepy.test.ts': "describe.skip('sleeping on stale assertions', () => {});\n",
  });

  const result = runGuard(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[warn\] R5 skip\/todo 1 处/);
  assert.match(result.stdout, /sleepy\.test\.ts:1/);
});

test('R10 seam 内 mock：无标记违规、豁免标记放行、注释引用不误报', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-r10-'));
  writeTree(root, {
    'policy.json': JSON.stringify(BASE_POLICY),
    'docs/active.md': specDoc('Active', '#### 验收：T-001 行为一\n'),
    'apps/x/src/__tests__/good.test.ts': '// @spec: T-001\n',
    'apps/x/src/__tests__/httpSeam.test.ts': [
      "vi.mock('@/client/api/gateway', () => ({ fetch: vi.fn() }));",
      '',
      '// guard-seam-mock-exempt: 外部 HTTP 边界替身，被测链路两端真实；待边界注入化后移除',
      "vi.mock('@/client/api/otherGateway', () => ({ fetch: vi.fn() }));",
      '',
      '// 历史：vi.mock( 曾在此处，已重构掉，注释保留说明',
    ].join('\n'),
  });

  const result = runGuard(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[warn\] R10 seam mock 1 处/);
  assert.match(result.stdout, /httpSeam\.test\.ts:1/);
  assert.doesNotMatch(result.stdout, /httpSeam\.test\.ts:4/);
  assert.doesNotMatch(result.stdout, /httpSeam\.test\.ts:7/);
});

test('R10 level=error 时违规升级为阻断', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-r10e-'));
  writeTree(root, {
    'policy.json': JSON.stringify({ ...BASE_POLICY, seamMock: { ...BASE_POLICY.seamMock, level: 'error' } }),
    'docs/active.md': specDoc('Active', '#### 验收：T-001 行为一\n'),
    'apps/x/src/__tests__/good.test.ts': '// @spec: T-001\n',
    'apps/x/src/__tests__/badSeam.test.ts': "vi.mock('../internalModule', () => ({}));\n",
  });

  const result = runGuard(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /R10/);
});

test('entryGlobs 未配置时 R4 明示跳过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-noglobs-'));
  writeTree(root, {
    'policy.json': JSON.stringify({ ...BASE_POLICY, entryGlobs: [] }),
    'docs/active.md': specDoc('Active', '#### 验收：T-001 行为一\n'),
    'apps/x/src/__tests__/good.test.ts': '// @spec: T-001\n',
  });

  const result = runGuard(root);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /R4 跳过：policy 未配置 entryGlobs/);
});

test('--retired-spec 点名列出验收 ID 的全部测试引用者', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkage-retired-'));
  writeTree(root, {
    'policy.json': JSON.stringify(BASE_POLICY),
    'docs/victim.md': specDoc('Active', '#### 验收：V-001 将被退役的行为\n\n#### 验收：V-002 无引用项\n'),
    'apps/x/src/__tests__/a.test.ts': '// @spec: V-001\n',
    'apps/x/src/__tests__/b.test.ts': '// @spec: V-001, T-OTHER\n',
  });

  const result = runGuard(root, ['--retired-spec', 'docs/victim.md']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /V-001 ← 2 处引用/);
  assert.match(result.stdout, /a\.test\.ts:1/);
  assert.match(result.stdout, /b\.test\.ts:1/);
  assert.match(result.stdout, /V-002 ← 无测试引用/);
});
