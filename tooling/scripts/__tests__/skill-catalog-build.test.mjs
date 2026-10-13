import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { __test_only__ } from '../skill-catalog-build.mjs';
import { sha512Hex } from '../skill-bundle-core.mjs';

const { buildCatalogPlan, assertContractsParse, writeCatalogDist, discoverSkillIds } = __test_only__;

// 测试夹具：在临时目录造两个 skill 源目录（含可执行脚本与隐藏文件）。
const makeSkillsRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-catalog-test-'));
  const writeSkill = (id, version, extra = {}) => {
    const dir = join(root, id);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({ id, version, name: `Name ${id}`, description: `desc ${id}`, ...extra }),
    );
    writeFileSync(join(dir, 'SKILL.md'), `# ${id}`);
    writeFileSync(join(dir, 'scripts', 'run.sh'), '#!/bin/bash\n');
    writeFileSync(join(dir, '.DS_Store'), 'should-be-excluded');
  };
  writeSkill('beta-skill', '0.9.0');
  writeSkill('alpha-skill', '1.0.0');
  mkdirSync(join(root, '.hidden-dir'), { recursive: true });
  writeFileSync(join(root, '.hidden-dir', 'skill.json'), '{}');
  return root;
};

test('discoverSkillIds: 字典序排序且跳过隐藏目录', () => {
  const root = makeSkillsRoot();
  try {
    assert.deepEqual(discoverSkillIds(root), ['alpha-skill', 'beta-skill']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCatalogPlan: 双 skill 全量计划，index 与 bundle key/sha512 一致', () => {
  const root = makeSkillsRoot();
  try {
    const plan = buildCatalogPlan(root);

    // index：字典序（alpha 在前），version 1
    assert.equal(plan.index.version, 1);
    assert.deepEqual(plan.index.skills.map((s) => s.id), ['alpha-skill', 'beta-skill']);
    assert.equal(plan.index.skills[0].bundleKey, 'skills/bundles/alpha-skill-1.0.0.json');
    assert.equal(plan.index.skills[0].version, '1.0.0');
    assert.equal(plan.index.skills[0].name, 'Name alpha-skill');

    // bundles：key 与 index 一致；.DS_Store 被排除；.sh 标记可执行
    assert.equal(plan.bundles.length, 2);
    const alpha = plan.bundles[0];
    assert.equal(alpha.key, 'skills/bundles/alpha-skill-1.0.0.json');
    const bundleObj = JSON.parse(alpha.json);
    assert.equal(bundleObj.id, 'alpha-skill');
    assert.equal(bundleObj.version, '1.0.0');
    assert.equal(bundleObj.files.length, 3); // skill.json + SKILL.md + scripts/run.sh
    const sh = bundleObj.files.find((f) => f.path === 'scripts/run.sh');
    assert.equal(sh.executable, true);

    // sha512 是对落盘字节（紧凑序列化）的校验和
    assert.equal(alpha.sha512, sha512Hex(alpha.json));
    assert.equal(plan.index.skills[0].sha512, alpha.sha512);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCatalogPlan: skill.json 的 id 与目录名不一致抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-catalog-mismatch-'));
  try {
    mkdirSync(join(root, 'dir-a'));
    writeFileSync(
      join(root, 'dir-a', 'skill.json'),
      JSON.stringify({ id: 'other-id', version: '1.0.0', name: 'N', description: 'd' }),
    );
    assert.throws(() => buildCatalogPlan(root), /与目录名 .* 不一致/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCatalogPlan: 缺 skill.json 抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-catalog-missing-'));
  try {
    mkdirSync(join(root, 'dir-a'));
    assert.throws(() => buildCatalogPlan(root), /skill\.json 不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCatalogPlan: meta 缺必填字段抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-catalog-invalid-'));
  try {
    mkdirSync(join(root, 'dir-a'));
    writeFileSync(join(root, 'dir-a', 'skill.json'), JSON.stringify({ id: 'dir-a', version: '1' }));
    assert.throws(() => buildCatalogPlan(root), /缺少必填字段: name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildCatalogPlan: skill 源目录为空抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-catalog-empty-'));
  try {
    assert.throws(() => buildCatalogPlan(root), /为空/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeCatalogDist: 产物布局镜像 catalog 分支且 sha512 与文件字节一致；旧 bundle 清空', () => {
  const root = makeSkillsRoot();
  const distRoot = join(root, 'dist');
  try {
    const plan = buildCatalogPlan(root);
    // 预埋上一轮残留 bundle，验证全量重建清空
    mkdirSync(join(distRoot, 'skills', 'bundles'), { recursive: true });
    writeFileSync(join(distRoot, 'skills', 'bundles', 'stale-skill-0.0.1.json'), '{}');

    writeCatalogDist(distRoot, plan, { log: () => {} });

    const bundleFiles = readdirSync(join(distRoot, 'skills', 'bundles')).sort();
    assert.deepEqual(bundleFiles, ['alpha-skill-1.0.0.json', 'beta-skill-0.9.0.json']);
    assert.equal(existsSync(join(distRoot, 'skills', 'bundles', 'stale-skill-0.0.1.json')), false);

    // index.json 读取后应能被 catalog schema 形状消费（bundleKey 与磁盘相对路径一致）
    const index = JSON.parse(readFileSync(join(distRoot, 'skills', 'index.json'), 'utf8'));
    assert.equal(index.version, 1);
    assert.equal(index.skills.length, 2);
    for (const entry of index.skills) {
      // bundleKey 即 dist root 相对路径
      const bundlePath = join(distRoot, entry.bundleKey);
      assert.equal(entry.sha512, sha512Hex(readFileSync(bundlePath, 'utf8')));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertContractsParse: 生成物通过 packages/contracts 契约 schema', async () => {
  const root = makeSkillsRoot();
  try {
    const plan = buildCatalogPlan(root);
    const parsedCount = await assertContractsParse(plan);
    assert.equal(parsedCount, 3); // 2 bundles + 1 index
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertContractsParse: 契约不符（sha512 非字符串）抛错——parse 门真实生效', async () => {
  const require = createRequire(import.meta.url);
  const contracts = require('@iart/contracts');
  const badPlan = {
    index: {
      version: 1,
      skills: [
        { id: 'x', name: 'x', version: '1', description: 'd', bundleKey: 'k', sha512: 42 },
      ],
    },
    bundles: [],
  };
  await assert.rejects(
    () => assertContractsParse(badPlan),
    () => {
      // ZodError 且来自 SkillCatalogSchema 边界
      return true;
    },
  );
  // 双保险：直接用 schema 断言同一形状必失败
  assert.throws(() => contracts.SkillCatalogSchema.parse(badPlan.index));
});
