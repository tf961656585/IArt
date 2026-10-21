#!/usr/bin/env node
// skill 目录发布：把本仓 skills/ 源发布到公开仓 skill-catalog 分支。
//
// 一条命令完成：构建 → 镜像同步 → commit → push → 推送后校验。
//
// 语义与口径：
//   - 同步是「镜像替换」：用 .skill-dist/skills/ 整体替换分支上的 skills/ 路径，
//     旧版本 bundle 随镜像移除（构建侧本就是全量清空重建）；
//     skills/ 之外的路径一律不触碰。「bundle 不可变」指同版本内容不变，不是不能删旧版本文件。
//   - 幂等：内容与分支现状完全一致时跳过 commit/push，输出 no change，不留空提交。
//   - 推送保护：推送前打印变更文件清单与新旧 index.json 对照（每个 skill 的 id/version/sha512）；
//     同版本号但 sha512 变化（内容被改而未升版本）直接拒绝发布（违反 bundle 不可变）。
//   - 失败语义：任何一步失败立即非零退出；发布动作在临时浅克隆中完成，本仓工作树、
//     本仓引用与 .git 状态不受影响（不新增 worktree、不留半提交状态，临时目录用完即删）。
//   - 推送后校验：重新拉取分支，逐项断言——分支 index.json 与本地产物字节一致；
//     每个 bundle 文件分支字节与本地产物字节一致且 sha512 与 index 条目一致；
//     未升版本的 skill 内容与发布前一致。任一断言失败非零退出并输出差异。
//
// 用法（在仓库根执行；也可从任意目录执行，路径均按本仓解析）:
//   node tooling/scripts/skill-catalog-publish.mjs
//
// 远端：取本仓 `git remote get-url origin`（即公开仓），不硬编码 URL。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import {
  buildCatalogPlan,
  assertContractsParse,
  writeCatalogDist,
  DEFAULT_DIST_ROOT,
  SKILLS_ROOT,
  REPO_ROOT,
} from './skill-catalog-build.mjs';
import { sha512Hex } from './skill-bundle-core.mjs';

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// 执行 git 命令并捕获 stdout（encoding='buffer' 时返回 Buffer）；
// stderr 透传终端（克隆/推送进度与报错直接可见）。失败抛带命令上下文的 Error。
const gitOut = (args, { cwd = REPO_ROOT, encoding = 'utf8' } = {}) => {
  try {
    // maxBuffer 必须显式放大：bundle 以 Buffer 读回，node 默认 1 MiB，
    // 超过即抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER（实测 1.07 MB 的 ppt-builder bundle
    // 让推送后校验误报失败，而推送本身已成功）。
    return execFileSync('git', args, {
      cwd,
      encoding,
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(`git ${args.join(' ')} 执行失败（详见上方 git 输出）`, { cause: err });
  }
};

// 递归枚举目录下所有文件，返回「相对路径 posix 化 → 字节内容」映射。
const fileMap = (rootDir) => {
  const map = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else map.set(relative(rootDir, p).split(path.sep).join('/'), fs.readFileSync(p));
    }
  };
  if (fs.existsSync(rootDir)) walk(rootDir);
  return map;
};

const shortSha = (sha) => `${sha.slice(0, 12)}…`;

// 新旧 index 的 skill 条目映射（id → entry）。
const entryMap = (index) => new Map((index?.skills ?? []).map((s) => [s.id, s]));

const main = async () => {
  // 1. 本地构建：复用 skill-catalog-build 的导出，产物落 .skill-dist/ 留作本地审计。
  console.log(`[1/5] 构建: ${SKILLS_ROOT}`);
  const plan = buildCatalogPlan(SKILLS_ROOT);
  const parsedCount = await assertContractsParse(plan);
  console.log(`  contracts schema 自验通过（${parsedCount} 份产物 parse 成功）`);
  const { written } = writeCatalogDist(DEFAULT_DIST_ROOT, plan);
  console.log(`  本地产物: ${DEFAULT_DIST_ROOT}（${written} 个文件）`);
  const distSkillsDir = join(DEFAULT_DIST_ROOT, 'skills');
  const distIndexBytes = fs.readFileSync(join(distSkillsDir, 'index.json'));
  const newEntries = entryMap(plan.index);

  // 2. 取公开仓地址，浅克隆 skill-catalog 分支到临时目录。
  console.log('[2/5] 克隆 skill-catalog 分支（临时浅克隆）');
  const remoteUrl = gitOut(['remote', 'get-url', 'origin']).trim();
  const tmpRoot = fs.mkdtempSync(join(os.tmpdir(), 'skill-catalog-publish-'));
  try {
    gitOut(['clone', '--depth', '1', '--branch', 'skill-catalog', remoteUrl, tmpRoot]);
    const cloneSkillsDir = join(tmpRoot, 'skills');
    const beforeFiles = fileMap(cloneSkillsDir);
    const beforeIndexPath = join(cloneSkillsDir, 'index.json');
    const beforeIndex = fs.existsSync(beforeIndexPath)
      ? JSON.parse(fs.readFileSync(beforeIndexPath, 'utf8'))
      : null;
    const beforeEntries = entryMap(beforeIndex);

    // 3. 镜像替换：删掉克隆里的 skills/ 整体换成本地产物（skills/ 之外不触碰）。
    console.log('[3/5] 镜像替换 skills/');
    fs.rmSync(cloneSkillsDir, { recursive: true, force: true });
    fs.cpSync(distSkillsDir, cloneSkillsDir, { recursive: true });
    const afterFiles = fileMap(cloneSkillsDir);

    // 推送保护（一）：变更文件清单（A 新增 / M 修改 / D 删除 / = 未变）。
    const added = [];
    const removed = [];
    const modified = [];
    const unchanged = [];
    const allPaths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort();
    for (const p of allPaths) {
      const before = beforeFiles.get(p);
      const after = afterFiles.get(p);
      if (before === undefined) added.push(p);
      else if (after === undefined) removed.push(p);
      else if (!before.equals(after)) modified.push(p);
      else unchanged.push(p);
    }
    console.log('  变更文件清单:');
    for (const p of added) console.log(`    A ${p}`);
    for (const p of modified) console.log(`    M ${p}`);
    for (const p of removed) console.log(`    D ${p}`);
    for (const p of unchanged) console.log(`    = ${p}（未变）`);

    // 推送保护（二）：新旧 index.json 对照 + 同版本号内容变化守卫。
    console.log('  index 对照:');
    const allIds = [...new Set([...beforeEntries.keys(), ...newEntries.keys()])].sort();
    for (const id of allIds) {
      const before = beforeEntries.get(id);
      const after = newEntries.get(id);
      if (!before) console.log(`    + ${id}: 新增 ${after.version} (${shortSha(after.sha512)})`);
      else if (!after) console.log(`    - ${id}: 移除（此前 ${before.version}）`);
      else if (before.version === after.version && before.sha512 === after.sha512) {
        console.log(`    = ${id}: ${after.version} (${shortSha(after.sha512)}) 未变`);
      } else {
        console.log(
          `    ~ ${id}: ${before.version} (${shortSha(before.sha512)}) → ${after.version} (${shortSha(after.sha512)})`,
        );
      }
      // bundle 不可变守卫：同版本号必须同内容（sha512 一致），否则拒绝发布。
      if (before && after && before.version === after.version && before.sha512 !== after.sha512) {
        fail(
          `同版本号内容变化（违反 bundle 不可变）: ${id} ${after.version} ` +
            `sha512 ${shortSha(before.sha512)} → ${shortSha(after.sha512)}；请先升版本号再发布`,
        );
      }
    }

    // 幂等：无任何变更则跳过 commit/push。
    if (added.length + modified.length + removed.length === 0) {
      console.log('✓ no change：分支内容与本地产物完全一致，跳过 commit/push');
      return;
    }

    // 4. commit + push（只提交 skills/ 路径）。
    console.log('[4/5] commit + push');
    const versions = plan.bundles.map((b) => `${b.id} ${b.version}`).join('、');
    const localHead = gitOut(['rev-parse', 'HEAD']).trim();
    const skillsDirty = gitOut(['status', '--porcelain', '--', 'skills/']).trim().length > 0;
    const subject = `chore(skill-catalog): 发布 skill 目录——${versions}`;
    const body = [
      `来源: IARTStudio local@${localHead}${skillsDirty ? '（skills/ 工作树含未提交改动，以工作树内容为准）' : ''}`,
      '产物: tooling/scripts/skill-catalog-build.mjs 全量构建；skill-catalog-publish.mjs 镜像替换 skills/',
    ].join('\n');
    gitOut(['add', '-A', 'skills/'], { cwd: tmpRoot });
    gitOut(['commit', '-m', subject, '-m', body], { cwd: tmpRoot });
    gitOut(['push', 'origin', 'HEAD:skill-catalog'], { cwd: tmpRoot });
    const pushedSha = gitOut(['rev-parse', 'HEAD'], { cwd: tmpRoot }).trim();

    // 5. 推送后校验：重新拉取分支，逐项断言（任一失败非零退出）。
    console.log('[5/5] 推送后校验');
    gitOut(['fetch', 'origin', 'skill-catalog'], { cwd: tmpRoot });
    const branchIndexBytes = gitOut(['show', 'origin/skill-catalog:skills/index.json'], {
      cwd: tmpRoot,
      encoding: 'buffer',
    });
    if (!branchIndexBytes.equals(distIndexBytes)) {
      fail('推送后校验失败: 分支 skills/index.json 与本地产物字节不一致');
    }
    const pushedIndex = JSON.parse(branchIndexBytes.toString('utf8'));
    const pushedEntries = entryMap(pushedIndex);
    for (const bundle of plan.bundles) {
      const branchBytes = gitOut(['show', `origin/skill-catalog:${bundle.key}`], {
        cwd: tmpRoot,
        encoding: 'buffer',
      });
      const distBytes = fs.readFileSync(join(DEFAULT_DIST_ROOT, bundle.key));
      if (!branchBytes.equals(distBytes)) {
        fail(`推送后校验失败: 分支 ${bundle.key} 与本地产物字节不一致`);
      }
      if (sha512Hex(branchBytes.toString('utf8')) !== bundle.sha512) {
        fail(`推送后校验失败: 分支 ${bundle.key} 实际 sha512 与 index 条目不一致`);
      }
      const entry = pushedEntries.get(bundle.id);
      if (!entry || entry.version !== bundle.version || entry.sha512 !== bundle.sha512) {
        fail(`推送后校验失败: index 条目与本地计划不一致 (${bundle.id})`);
      }
      console.log(`  ✓ ${bundle.id} ${bundle.version} sha512 ${shortSha(bundle.sha512)} 与本地产物一致`);
    }
    // 未升版本的 skill 必须与发布前完全一致（sha512 不变）。
    for (const [id, before] of beforeEntries) {
      const after = pushedEntries.get(id);
      if (!after) continue; // 移除属于镜像语义，无需断言
      if (before.version === after.version && before.sha512 !== after.sha512) {
        fail(
          `推送后校验失败: ${id} 版本未变 (${after.version}) 但 sha512 变化 ` +
            `(${shortSha(before.sha512)} → ${shortSha(after.sha512)})`,
        );
      }
      if (before.sha512 === after.sha512) {
        console.log(`  ✓ ${id}: 与发布前一致（${after.version}，${shortSha(after.sha512)}）`);
      }
    }

    console.log(`✓ 发布完成: ${remoteUrl} skill-catalog @ ${pushedSha}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
};

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
