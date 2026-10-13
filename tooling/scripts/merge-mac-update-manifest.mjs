#!/usr/bin/env node
// 合并 mac 双架构的 electron-builder latest-mac.yml（批次 1 收尾修正，裁定可选 (a)）。
//
// 背景：mac job 在 arm64 runner 上分两次 electron-builder 构建后，每次构建都会用
// 单架构条目覆盖 dist-desktop/latest-mac.yml；electron-updater 要求 latest-mac.yml
// 同时携带 arm64 与 x64 的 zip 条目（对齐 desktop-release-local.mjs buildLatestMacYaml
// 的输出形状：files = 双架构 zip 条目，顶层 path/sha512 = arm64 主条目，sha512 base64）。
// 本脚本把两次构建各产的 latest-mac.yml 合并成一份。
//
// 合并语义（裁定口径）：
//   - files：两份 yml 的条目按 url union，arm64 侧（第一输入）在前；同 url 且内容
//     （sha512/size）一致时去重，不一致视为产物损坏即失败。
//   - 顶层 version / releaseDate：取 releaseDate 较新一侧的值（两次构建同一版本树，
//     正常应一致；不一致时以新者为准并留 warn）。
//   - 顶层 path / sha512 / size：取 arm64 侧（第一输入）顶层字段（electron-updater
//     兼容投影的 primary 条目）。
//
// 用法:
//   node tooling/scripts/merge-mac-update-manifest.mjs <arm64-latest-mac.yml> <x64-latest-mac.yml> [--out <merged.yml>]
//
// 无 --out 时合并结果写 stdout；任一输入结构非法以非零退出码终止。

import fs from 'node:fs';
import yaml from 'js-yaml';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fail = (msg) => {
  console.error(`✗ [merge-mac-update-manifest] ${msg}`);
  process.exit(1);
};

// 读取并结构校验一份 latest-mac.yml。返回普通对象。
export function readLatestMacYml(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    fail(`无法读取 ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let doc;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    fail(`YAML 解析失败 ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const problems = validateLatestMacYml(doc);
  if (problems.length > 0) {
    fail(`结构非法 ${filePath}:\n  - ${problems.join('\n  - ')}`);
  }
  return doc;
}

// 结构校验：返回问题列表（空数组 = 合法）。独立导出供测试与消费端复用。
export function validateLatestMacYml(doc) {
  const problems = [];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return ['latest-mac.yml 必须是 YAML 对象'];
  }
  if (typeof doc.version !== 'string' || !doc.version) {
    problems.push('缺少 version（非空字符串）');
  }
  if (typeof doc.releaseDate !== 'string' || !doc.releaseDate) {
    problems.push('缺少 releaseDate（非空字符串）');
  } else if (Number.isNaN(Date.parse(doc.releaseDate))) {
    problems.push(`releaseDate 不是可解析时间: ${doc.releaseDate}`);
  }
  if (!Array.isArray(doc.files) || doc.files.length === 0) {
    problems.push('files 必须是非空数组');
  } else {
    doc.files.forEach((entry, i) => {
      const label = `files[${i}]`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(`${label} 必须是对象`);
        return;
      }
      if (typeof entry.url !== 'string' || !entry.url) problems.push(`${label}.url 缺失`);
      if (typeof entry.sha512 !== 'string' || !entry.sha512) problems.push(`${label}.sha512 缺失`);
      if (typeof entry.size !== 'number' || !Number.isFinite(entry.size)) {
        problems.push(`${label}.size 必须是数字`);
      }
    });
  }
  if (typeof doc.path !== 'string' || !doc.path) problems.push('缺少 path（主条目文件名）');
  if (typeof doc.sha512 !== 'string' || !doc.sha512) problems.push('缺少顶层 sha512（base64）');
  return problems;
}

// 纯合并：arm64Doc 为第一输入（primary），x64Doc 为第二输入。
// 返回合并后的普通对象（与 buildLatestMacYaml 的输出形状一致）。
export function mergeLatestMacYamls(arm64Doc, x64Doc) {
  const arm64Newer = Date.parse(arm64Doc.releaseDate) >= Date.parse(x64Doc.releaseDate);
  const newer = arm64Newer ? arm64Doc : x64Doc;
  if (arm64Doc.version !== x64Doc.version) {
    console.warn(
      `[merge-mac-update-manifest] 两份 yml version 不一致（${arm64Doc.version} vs ${x64Doc.version}），取 releaseDate 较新一侧: ${newer.version}`,
    );
  }

  // files 按 url union，arm64 侧在前；同 url 同内容去重，同 url 异内容即失败。
  const files = [];
  const byUrl = new Map();
  for (const entry of [...arm64Doc.files, ...x64Doc.files]) {
    const existing = byUrl.get(entry.url);
    if (!existing) {
      byUrl.set(entry.url, entry);
      files.push(entry);
      continue;
    }
    if (existing.sha512 !== entry.sha512 || existing.size !== entry.size) {
      throw new Error(
        `files 条目 url 冲突且内容不一致: ${entry.url}（${existing.sha512.slice(0, 12)}…/${existing.size} vs ${entry.sha512.slice(0, 12)}…/${entry.size}）`,
      );
    }
  }

  return {
    version: newer.version,
    files,
    path: arm64Doc.path,
    sha512: arm64Doc.sha512,
    releaseDate: newer.releaseDate,
  };
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
  const positional = process.argv.slice(2).filter((arg, i, arr) => {
    if (arg === '--out') return false;
    if (arg.startsWith('--out=')) return false;
    if (i > 0 && arr[i - 1] === '--out') return false;
    return true;
  });
  if (positional.length !== 2) {
    fail('用法: node tooling/scripts/merge-mac-update-manifest.mjs <arm64-latest-mac.yml> <x64-latest-mac.yml> [--out <merged.yml>]');
  }
  const [arm64Path, x64Path] = positional;
  const arm64Doc = readLatestMacYml(arm64Path);
  const x64Doc = readLatestMacYml(x64Path);
  const merged = mergeLatestMacYamls(arm64Doc, x64Doc);
  const content = yaml.dump(merged, { lineWidth: 120 });
  const outPath = parseOutArg(process.argv.slice(2));
  if (outPath) {
    fs.writeFileSync(resolve(process.cwd(), outPath), content);
    console.log(`✓ latest-mac.yml 已合并 → ${outPath}（${merged.files.length} 个条目，version ${merged.version}）`);
  } else {
    process.stdout.write(content);
  }
}

export const __test_only__ = {
  readLatestMacYml,
  validateLatestMacYml,
  mergeLatestMacYamls,
};
