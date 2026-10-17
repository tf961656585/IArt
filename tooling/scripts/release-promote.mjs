#!/usr/bin/env node
// release-promote —— draft release 转正式 + 更新 feed 生效自检（一条龙）。
//
// 背景与口径（docs/desktop-updates/README.md）：
//   - releases/latest/download 只服务最新正式 release 的资产，draft 资产对更新 feed 不可见；
//     「人工把 draft 转正式」因此是发版激活动作。该步被遗漏时，已装客户端的更新检查
//     会持续 404（2026-10-16 实证：v0.6.3–v0.6.11 多个 draft 滞留，客户端更新天天失败）。
//   - 本脚本把「落版本 tag + 转正式 + feed 生效自检」合成一步：转正前先校验根 package.json
//     的 version（在制版本）与 tag 一致，再按 GitHub API 把 tag 落在草稿记录的来源提交
//     （targetCommitish）上——本地 git 历史与公开仓不同源，禁止用本地 git tag + push。
//     随后翻正式（只翻状态不重新构建），立即探测三份 feed 文件可达且 version 与 tag 一致；
//     feed 未生效视同未发版。
//   - feed 基址读根 package.json 的 build.publish.url（generic provider）——与打包进
//     安装包 app-update.yml 的是同一事实源，本脚本不维护第二份 feed 地址。
//
// 用法（在仓库根或任意目录执行均可；gh 仓库上下文取当前仓库，公开仓即本仓 origin）：
//   node tooling/scripts/release-promote.mjs v0.6.3                # 落 tag + 转正式 + 验证
//   node tooling/scripts/release-promote.mjs v0.6.3 --verify-only  # 只验证，不改 release 状态、不落 tag
//
// 失败语义：任一步失败立即非零退出；tag 已存在且指向不同提交、package.json version 与 tag
// 不一致均拒绝执行（不覆盖已有 tag）；feed 探测逐项给出 ✓/✗ 后统一收口，✗ 行附下一步动作提示。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

// 三平台 feed 文件：win 消费 latest.yml，mac 消费 latest-mac.yml，linux 为 latest-linux.yml
const FEED_FILES = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];

const fail = (msg) => {
  console.error(`✗ [release-promote] ${msg}`);
  process.exit(1);
};

// 执行 gh 命令并捕获 stdout；stderr 透传终端（进度与报错直接可见）。失败抛带命令上下文的 Error。
const ghOut = (args) => {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (err) {
    throw new Error(`gh ${args.join(' ')} 执行失败（详见上方 gh 输出；确认已 gh auth login 且对公开仓有权限）`, { cause: err });
  }
};

// feed 基址取根 package.json build.publish（generic provider）。缺省参数读真实 package.json，
// 测试显式传入夹具。形状非法抛错，由调用方（main 顶层 catch）转为 fail 退出。
export function readFeedBaseUrl(pkg = JSON.parse(fs.readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'))) {
  const publish = pkg.build && pkg.build.publish ? pkg.build.publish : undefined;
  const entry = Array.isArray(publish) ? publish[0] : publish;
  if (
    entry === null || typeof entry !== 'object' ||
    entry.provider !== 'generic' || typeof entry.url !== 'string' || entry.url.trim() === ''
  ) {
    throw new Error('package.json build.publish 不是含 url 的 generic provider，无法确定更新 feed 基址');
  }
  return entry.url.replace(/\/+$/, '');
}

// latest*.yml 顶层 version 字段（electron-builder 生成形状）。非法形状返回 null。
export function parseFeedVersion(yamlText) {
  let doc;
  try {
    doc = yaml.load(yamlText);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (typeof doc.version !== 'string' || doc.version.trim() === '') return null;
  return doc.version.trim();
}

const normalizeVersion = (tag) => tag.replace(/^v/, '');

// 根 package.json 的 version（在制版本）。缺省参数读真实 package.json，测试显式传入夹具。
export function readPackageVersion(pkg = JSON.parse(fs.readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'))) {
  const version = pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg.version : undefined;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('根 package.json 缺少 version，无法校验转正一致性');
  }
  return version.trim();
}

// 转正前校验（仅转正动作，--verify-only 不含）：在制版本恒等于下一次发布意图的号，
// package.json version 必须等于 tag（去 v 前缀），不一致拒绝转正。
export function assertPromotable(tag, packageVersion) {
  const version = typeof packageVersion === 'string' ? packageVersion.trim() : '';
  if (version === '') throw new Error('package.json version 为空，拒绝转正');
  const expected = normalizeVersion(tag);
  if (version !== expected) {
    throw new Error(
      `根 package.json version=${version} 与 tag ${tag}（${expected}）不一致，拒绝转正：` +
        '在制版本应等于下一次发布意图的号，确认是否已进位或转错了稿',
    );
  }
}

// 从 git/matching-refs 响应中取精确匹配 refs/tags/<tag> 的 ref。matching-refs 按前缀匹配
// （查 v0.6.3 会带上 v0.6.30 等），必须精确比对 ref 字符串。不存在返回 null。
export function findExactTagRef(refs, tag) {
  if (!Array.isArray(refs)) return null;
  const wanted = `refs/tags/${tag}`;
  for (const ref of refs) {
    if (ref !== null && typeof ref === 'object' && !Array.isArray(ref) && ref.ref === wanted) return ref;
  }
  return null;
}

// 落 tag 动作裁决：tag 不存在 → 'create'；已存在且指向同一提交 → 'skip'（幂等）；
// 指向不同提交 → 抛错（拒绝覆盖已有 tag）。
export function resolveTagAction(existingCommitSha, targetCommitish) {
  const target = typeof targetCommitish === 'string' ? targetCommitish.trim() : '';
  if (target === '') {
    throw new Error('草稿未记录 targetCommitish（来源提交），无法落 tag：确认是否手工创建过该 release');
  }
  if (existingCommitSha === null || existingCommitSha === undefined) return 'create';
  const existing = String(existingCommitSha).trim();
  if (existing === target) return 'skip';
  throw new Error(
    `tag 已存在且指向 ${existing}，与草稿来源提交 ${target} 不一致；拒绝覆盖已有 tag（确认是否发错稿或需进位改号）`,
  );
}

// 已存在 tag ref 指向的 commit sha：轻量 tag（object.type=commit）直接取 object.sha；
// 附注 tag（object.type=tag）经 git/tags API 解引用到其指向的 commit。
const readRefCommitSha = (ref) => {
  const object = ref !== null && typeof ref === 'object' && !Array.isArray(ref) ? ref.object : undefined;
  const sha = object !== null && typeof object === 'object' && !Array.isArray(object) ? object.sha : undefined;
  if (typeof sha !== 'string' || sha.trim() === '') {
    throw new Error('tag ref 响应缺少 object.sha，无法判定已存在 tag 指向的提交');
  }
  if (object.type === 'commit') return sha.trim();
  if (object.type === 'tag') {
    const tagObject = JSON.parse(ghOut(['api', `repos/{owner}/{repo}/git/tags/${sha.trim()}`]));
    const target = tagObject !== null && typeof tagObject === 'object' && !Array.isArray(tagObject) ? tagObject.object : undefined;
    const targetSha = target !== null && typeof target === 'object' && !Array.isArray(target) ? target.sha : undefined;
    if (typeof targetSha !== 'string' || targetSha.trim() === '') {
      throw new Error('附注 tag 响应缺少 object.sha，无法判定其指向的 commit');
    }
    return targetSha.trim();
  }
  throw new Error(`tag ref 指向未知对象类型 ${String(object.type)}`);
};

const probeFeedFile = async (baseUrl, fileName, expectedVersion) => {
  const url = `${baseUrl}/${fileName}`;
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    return { ok: false, detail: `请求失败：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!response.ok) {
    return {
      ok: false,
      detail: `HTTP ${response.status}（404 = draft 未转正式或 Actions 未上传该文件）`,
    };
  }
  const version = parseFeedVersion(await response.text());
  if (version === null) return { ok: false, detail: '响应不是含 version 字段的 latest YAML' };
  if (version !== expectedVersion) {
    return { ok: false, detail: `feed version=${version}，与 tag 版本 ${expectedVersion} 不一致` };
  }
  return { ok: true, detail: `version ${version}` };
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

const main = async () => {
  const argv = process.argv.slice(2);
  const verifyOnly = argv.includes('--verify-only');
  const tag = argv.find((arg) => !arg.startsWith('--'));
  if (!tag || !/^v?\d+\.\d+\.\d+/.test(tag)) {
    fail('用法: node tooling/scripts/release-promote.mjs <tag> [--verify-only]（tag 形如 v0.6.3）');
  }
  const expectedVersion = normalizeVersion(tag);

  console.log('[1/3] 读取更新 feed 基址（package.json build.publish）');
  const baseUrl = readFeedBaseUrl();
  console.log(`  ✓ ${baseUrl}`);

  console.log(`[2/3] 检查 release ${tag}`);
  let view;
  try {
    view = JSON.parse(ghOut(['release', 'view', tag, '--json', 'isDraft,name,targetCommitish']));
  } catch (err) {
    fail(`release ${tag} 不存在或不可访问：${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`  ✓ ${view.name}${view.isDraft ? '（draft）' : '（已正式）'}`);
  if (view.isDraft && !verifyOnly) {
    console.log('  - 转正前校验：根 package.json version（在制版本）必须等于 tag');
    const packageVersion = readPackageVersion();
    assertPromotable(tag, packageVersion);
    console.log(`    ✓ package.json version=${packageVersion}`);

    console.log('  - 转正前落版本 tag（GitHub API，指向草稿记录的来源提交）');
    const targetCommitish = typeof view.targetCommitish === 'string' ? view.targetCommitish.trim() : '';
    const refs = JSON.parse(ghOut(['api', `repos/{owner}/{repo}/git/matching-refs/tags/${tag}`]));
    const existingRef = findExactTagRef(refs, tag);
    const existingSha = existingRef === null ? null : readRefCommitSha(existingRef);
    const tagAction = resolveTagAction(existingSha, targetCommitish);
    if (tagAction === 'create') {
      ghOut(['api', 'repos/{owner}/{repo}/git/refs', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${targetCommitish}`]);
      console.log(`    ✓ 已创建 tag ${tag} → ${targetCommitish}`);
    } else {
      console.log(`    - tag ${tag} 已存在且指向 ${targetCommitish}（幂等跳过）`);
    }

    ghOut(['release', 'edit', tag, '--draft=false']);
    console.log('  ✓ 已转正式');
  } else if (view.isDraft) {
    console.log('  - --verify-only：保持 draft 状态（此时 feed 预期不可达）');
  }

  console.log('[3/3] 探测更新 feed（releases/latest/download）');
  let probeFailed = false;
  for (const fileName of FEED_FILES) {
    const result = await probeFeedFile(baseUrl, fileName, expectedVersion);
    if (result.ok) {
      console.log(`  ✓ ${fileName}：${result.detail}`);
    } else {
      probeFailed = true;
      console.error(`  ✗ ${fileName}：${result.detail}`);
    }
  }
  if (probeFailed) {
    fail(
      `更新 feed 未生效，视同未发版。下一步：确认 ${tag} 的 draft 已转正式且 Actions 已上传全部资产；` +
        `draft 未转正式时可运行 node tooling/scripts/release-promote.mjs ${tag}（不带 --verify-only）转正式并复验。`,
    );
  }
  console.log(`✓ 更新 feed 已生效：${tag} 发版完成`);
};

if (isDirectExecution()) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}

export const __test_only__ = {
  parseFeedVersion,
  readFeedBaseUrl,
  normalizeVersion,
  FEED_FILES,
  readPackageVersion,
  assertPromotable,
  findExactTagRef,
  resolveTagAction,
};
