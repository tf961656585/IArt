#!/usr/bin/env node
// skill 目录本地构建（公开仓 skill 分发基座，批次 1）。
//
// 从 `skills/<id>/` 源目录产出本地产物目录 `.skill-dist/`：
//   - `skills/index.json`（目录指针，全量重建）
//   - `skills/bundles/<id>-<version>.json`（bundle，紧凑序列化，sha512 与文件字节一致）
//
// 输出布局镜像公开仓 skill-catalog 分支的结构（apps/hub/src/client/skills/index.ts
// 拉取 `<catalog-base>/skills/index.json`，bundle URL 为 `<catalog-base>/<bundleKey>`，
// bundleKey 形如 `skills/bundles/<id>-<version>.json`），产物可直接整体拷入该分支推送。
//
// 校验/打包/sha512 逻辑复用共享模块 skill-bundle-core.mjs（与 skill-publish.mjs 共同消费）；
// 生成物用 packages/contracts 的 Zod schema（SkillBundleSchema / SkillCatalogSchema）
// 做一次 parse 自验，契约不符即非零退出。
//
// 用法:
//   node tooling/scripts/skill-catalog-build.mjs [--out <dist-root>]
//
// 默认 dist root 为仓库根 `.skill-dist/`（gitignore 的构建产物，不入库）。
// 每次运行全量重建：bundles 目录先清空再写入，避免版本升级后旧 bundle 残留。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildSkillBundle,
  validateSkillBundle,
  validateSkillMeta,
  buildIndexJson,
  sha512Hex,
} from './skill-bundle-core.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, '..', '..');
export const SKILLS_ROOT = resolve(REPO_ROOT, 'skills');
export const DEFAULT_DIST_ROOT = resolve(REPO_ROOT, '.skill-dist');

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// 枚举 skill 源目录 id（跳过隐藏目录，字典序稳定排序）。
export function discoverSkillIds(skillsRoot) {
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

// 只读构建：从 skills/ 源目录产出完整目录计划（不改磁盘）。
// 返回 { index: { version, skills }, bundles: [{ id, version, key, json, sha512 }] }。
// 任何 id/目录名不一致、meta/bundle 校验失败都以抛错终止。
export function buildCatalogPlan(skillsRoot) {
  const ids = discoverSkillIds(skillsRoot);
  if (ids.length === 0) {
    throw new Error(`skill 源目录为空（未发现任何 skill 子目录）: ${skillsRoot}`);
  }

  const bundles = [];
  let index = null;
  for (const id of ids) {
    const skillDir = path.join(skillsRoot, id);
    const skillJsonPath = path.join(skillDir, 'skill.json');
    if (!fs.existsSync(skillJsonPath)) {
      throw new Error(`skill.json 不存在: skills/${id}/skill.json`);
    }
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(skillJsonPath, 'utf8'));
    } catch (err) {
      throw new Error(
        `skill.json 解析失败 (skills/${id}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const metaValidation = validateSkillMeta(meta);
    if (!metaValidation.ok) {
      throw new Error(`skills/${id}/skill.json: ${metaValidation.message}`);
    }
    if (meta.id !== id) {
      throw new Error(`skill.json 的 id (${meta.id}) 与目录名 (${id}) 不一致`);
    }

    const bundle = buildSkillBundle(skillDir, meta);
    const bundleValidation = validateSkillBundle(bundle);
    if (!bundleValidation.ok) {
      throw new Error(`skills/${id}: ${bundleValidation.message}`);
    }

    // bundle 序列化必须与落盘字节一致：index 里的 sha512 才是对该文件的校验和。
    const json = JSON.stringify(bundle);
    const key = `skills/bundles/${meta.id}-${meta.version}.json`;
    bundles.push({ id: meta.id, version: meta.version, key, json, sha512: sha512Hex(json) });
    index = buildIndexJson(index, meta, key, bundles[bundles.length - 1].sha512);
  }

  return { index, bundles };
}

// 用 packages/contracts 的 Zod schema 对生成物做边界自验（契约不符抛错）。
// contracts 是 CJS 包（main dist/index.js），用 createRequire 规避 ESM 命名导出探测。
export async function assertContractsParse(plan) {
  const require = createRequire(import.meta.url);
  let contracts;
  try {
    contracts = require('@iart/contracts');
  } catch (err) {
    throw new Error(
      `无法加载 @iart/contracts（先执行 pnpm --filter @iart/contracts build）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  for (const bundle of plan.bundles) {
    contracts.SkillBundleSchema.parse(JSON.parse(bundle.json));
  }
  contracts.SkillCatalogSchema.parse(plan.index);
  return plan.bundles.length + 1; // bundles + index
}

// 落盘：清空重建 bundles 目录 + 写 index.json。返回写入文件数。
export function writeCatalogDist(distRoot, plan, { log = console.log } = {}) {
  const bundlesDir = path.join(distRoot, 'skills', 'bundles');
  fs.rmSync(bundlesDir, { recursive: true, force: true });
  fs.mkdirSync(bundlesDir, { recursive: true });

  let written = 0;
  for (const bundle of plan.bundles) {
    // key 即 dist root 相对路径（skills/bundles/<id>-<version>.json），与 catalog 分支布局一致
    const filePath = path.join(distRoot, bundle.key);
    fs.writeFileSync(filePath, bundle.json);
    log(`  + ${bundle.key} (sha512: ${bundle.sha512.slice(0, 12)}...)`);
    written += 1;
  }

  const indexPath = path.join(distRoot, 'skills', 'index.json');
  fs.writeFileSync(indexPath, `${JSON.stringify(plan.index, null, 2)}\n`);
  log(`  + skills/index.json (${plan.index.skills.length} 个 skill)`);
  return { written: written + 1, indexPath, bundlesDir };
}

const parseOutArg = (argv) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) return next;
      fail('参数 --out 缺少值');
    }
    if (argv[i].startsWith('--out=')) {
      return argv[i].slice('--out='.length);
    }
  }
  return undefined;
};

const main = async () => {
  const distRootArg = parseOutArg(process.argv.slice(2));
  const distRoot = distRootArg ? resolve(process.cwd(), distRootArg) : DEFAULT_DIST_ROOT;

  console.log(`skill-catalog-build: 源目录 ${SKILLS_ROOT}`);
  const plan = buildCatalogPlan(SKILLS_ROOT);

  const parsedCount = await assertContractsParse(plan);
  console.log(`contracts schema 自验通过（${parsedCount} 份产物 parse 成功）`);

  const { written } = writeCatalogDist(distRoot, plan);
  console.log(`✓ 产出完成: ${distRoot}（${written} 个文件，${plan.bundles.length} 个 skill）`);
};

const isDirectExecution = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
};

if (isDirectExecution()) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}

export const __test_only__ = {
  buildCatalogPlan,
  assertContractsParse,
  writeCatalogDist,
  discoverSkillIds,
  DEFAULT_DIST_ROOT,
  SKILLS_ROOT,
};
