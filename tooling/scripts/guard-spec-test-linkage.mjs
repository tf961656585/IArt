#!/usr/bin/env node
// guard:spec-test-linkage — 测试↔spec 关联与测试活性守卫
//
// 规则语义唯一事实源：用户级 test-linkage skill references/linkage-spec.md（R1/R2/R4/R5/R6/R10）。
// ID 与标注格式约定同源 spec-guide references/consistency-checks.md；
// 验收/废弃/标注正则与 spec-guide scripts/trace_acceptance.py 保持兼容，勿单方改动。
//
// 规则：
// - R1（阻断）测试 @spec 标注的 ID 必须属于 Active spec/contract 的「验收：<ID>」。
//   违规分三类：命中「废弃：<ID>」→ 已废弃（语义翻转信号，旧行为测试）；
//   属于终态 spec（Superseded/Deprecated/Archived）→ 已随 spec 退役；全仓未定义 → 拼写/缺失。
// - R2（阻断）同一 ID 不得在两份 Active 产物定义为验收项；终态与 Active 重号出提示（编号复用嫌疑）。
// - R4（提示）测试文件不被任何运行入口 glob 覆盖 = 孤儿测试文件（从不被批量执行）。
//   运行入口（vitest include / test:backend / test:scripts）变更时必须同步 policy entryGlobs。
// - R5（提示）describe/it/test 的 .skip/.todo/.fails 清单（沉睡测试逐个裁定）。
// - R6（读数）Active 验收 ID 覆盖代理读数，不设阈值。
// - R10（提示档，policy seamMock.level 可升阻断）文件名含 seam 的测试内出现模块级 mock
//   （vi.mock/vi.doMock/jest.mock）。合法边界替身/副作用隔离在命中处附近（同行或前 3 行）
//   打豁免标记 guard-seam-mock-exempt 并附原因；桩被测链路的必须重构，不得豁免。
//
// policy 位于 tooling/policies/test-linkage.policy.json。

import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp, readJson, toPosix } from './policy-scan-utils.mjs';

const DEFAULT_POLICY_PATH = 'tooling/policies/test-linkage.policy.json';

// 验收项标题：#### 验收：<ID>（ID 允许尾随描述文字）
const ACCEPTANCE_RE = /^#{1,6}\s*验收\s*[:：]\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s|$)/gm;
// 显式废弃标题：#### 废弃：<ID>（ID 保留原文、语义不再验收）
const DEPRECATED_RE = /^#{1,6}\s*废弃\s*[:：]\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s|$)/gm;
// 测试侧标注：@spec: ID, ID（只取同行；分隔与 token 校验同 trace_acceptance.py）
const SPEC_TAG_RE = /@spec\s*[:：][ \t]*([^\n]*)/gi;
const ANNOTATION_SPLIT_RE = /[,\s"'`(){}[\];]+/;
const ID_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SKIP_AUDIT_RE = /\b(?:describe|it|test)\s*\.\s*(?:skip|todo|fails)\b/;

// 纯产物/依赖目录不进入测试文件扫描（glob 之外的硬剪枝）。
const PRUNE_DIR_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'dist-static', '.publish', 'coverage', 'build',
]);

const readText = (filePath) => fs.readFileSync(filePath, 'utf8');

const parseFrontmatter = (text) => {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return { type: '', status: '' };
  const block = match[1];
  const typeLine = /^type:\s*(.+?)\s*$/m.exec(block);
  const statusLine = /^status:\s*(.+?)\s*$/m.exec(block);
  return { type: typeLine?.[1] ?? '', status: statusLine?.[1] ?? '' };
};

const collectSpecFiles = (root, docs) => {
  const specs = [];
  for (const dirName of docs.dirs) {
    const base = path.join(root, dirName);
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const absPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (docs.excludeDirNames.includes(entry.name)) continue;
          stack.push(absPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const text = readText(absPath);
        const { type, status } = parseFrontmatter(text);
        const acceptance = new Map();
        const deprecated = new Map();
        for (const match of text.matchAll(ACCEPTANCE_RE)) {
          if (!acceptance.has(match[1])) acceptance.set(match[1], countLines(text, match.index));
        }
        for (const match of text.matchAll(DEPRECATED_RE)) {
          if (!deprecated.has(match[1])) deprecated.set(match[1], countLines(text, match.index));
        }
        specs.push({
          relPath: toPosix(path.relative(root, absPath)),
          type,
          status,
          acceptance,
          deprecated,
        });
      }
    }
  }
  return specs;
};

const countLines = (text, index) => text.slice(0, index).split('\n').length;

const collectTestFiles = (root, policy) => {
  const excludeRegexes = (policy.excludeGlobs ?? []).map(globToRegExp);
  const suffixes = policy.testSuffixes;
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (PRUNE_DIR_NAMES.has(entry.name)) continue;
        stack.push(absPath);
        continue;
      }
      if (!entry.isFile() || !suffixes.some((suffix) => entry.name.endsWith(suffix))) continue;
      const relPath = toPosix(path.relative(root, absPath));
      if (excludeRegexes.some((regex) => regex.test(relPath))) continue;
      files.push({ absPath, relPath });
    }
  }
  return files.sort((left, right) => left.relPath.localeCompare(right.relPath));
};

const scanAnnotations = (text) => {
  const annotations = [];
  for (const match of text.matchAll(SPEC_TAG_RE)) {
    const ids = match[1]
      .split(ANNOTATION_SPLIT_RE)
      .filter((token) => token && ID_TOKEN_RE.test(token));
    if (ids.length === 0) continue;
    annotations.push({ line: countLines(text, match.index), ids });
  }
  return annotations;
};

const scanSkipHits = (text) => {
  const hits = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (SKIP_AUDIT_RE.test(lines[index])) hits.push({ line: index + 1, text: lines[index].trim() });
  }
  return hits;
};

const scanSeamMockViolations = (text, seamMock) => {
  const lines = text.split('\n');
  const violations = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!seamMock.detect.some((probe) => line.includes(probe))) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    const window = lines.slice(Math.max(0, index - 3), index + 1).join('\n');
    if (window.includes(seamMock.exemptMarker)) continue;
    violations.push({ line: index + 1, text: trimmed });
  }
  return violations;
};

const resolveArgs = (argv) => {
  const args = { root: process.cwd(), policy: DEFAULT_POLICY_PATH, retiredSpec: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') {
      args.root = path.resolve(argv[index + 1] ?? '');
      index += 1;
    } else if (argv[index] === '--policy') {
      args.policy = argv[index + 1] ?? DEFAULT_POLICY_PATH;
      index += 1;
    } else if (argv[index] === '--retired-spec') {
      args.retiredSpec = argv[index + 1] ?? '';
      index += 1;
    }
  }
  return args;
};

const listRetiredSpecReferences = (root, policy, specRelPath) => {
  const specAbs = path.resolve(root, specRelPath);
  if (!fs.existsSync(specAbs)) {
    console.error(`spec 文件不存在: ${specRelPath}`);
    return 2;
  }
  const text = readText(specAbs);
  const spec = { acceptance: new Map() };
  for (const match of text.matchAll(ACCEPTANCE_RE)) {
    if (!spec.acceptance.has(match[1])) spec.acceptance.set(match[1], countLines(text, match.index));
  }
  if (spec.acceptance.size === 0) {
    console.log(`该 spec 无验收 ID: ${specRelPath}`);
    return 0;
  }
  const references = new Map([...spec.acceptance.keys()].map((item) => [item, []]));
  for (const file of collectTestFiles(root, policy)) {
    for (const annotation of scanAnnotations(readText(file.absPath))) {
      for (const itemId of annotation.ids) {
        if (!references.has(itemId)) continue;
        references.get(itemId).push(`${file.relPath}:${annotation.line}`);
      }
    }
  }
  console.log(`Spec: ${specRelPath}，验收 ID ${references.size} 个`);
  for (const [itemId, refs] of references) {
    if (refs.length === 0) {
      console.log(`  ${itemId} ← 无测试引用`);
      continue;
    }
    console.log(`  ${itemId} ← ${refs.length} 处引用:`);
    for (const ref of refs) console.log(`    - ${ref}`);
  }
  return 0;
};

const main = () => {
  const args = resolveArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const policy = readJson(path.resolve(root, args.policy));

  if (args.retiredSpec) return listRetiredSpecReferences(root, policy, args.retiredSpec);

  const docs = policy.docs;
  const activeStatuses = new Set(docs.activeStatuses);
  const terminalStatuses = new Set(docs.terminalStatuses);
  const eligibleSpecs = collectSpecFiles(root, docs).filter((spec) => docs.specTypes.includes(spec.type));
  const activeSpecs = eligibleSpecs.filter((spec) => activeStatuses.has(spec.status));

  const activeIdOwners = new Map();
  for (const spec of activeSpecs) {
    for (const itemId of spec.acceptance.keys()) {
      if (!activeIdOwners.has(itemId)) activeIdOwners.set(itemId, spec);
    }
  }
  const deprecatedOwners = new Map();
  const allIdOwners = new Map();
  for (const spec of eligibleSpecs) {
    for (const itemId of spec.deprecated.keys()) {
      if (!deprecatedOwners.has(itemId)) deprecatedOwners.set(itemId, spec);
    }
    for (const itemId of [...spec.acceptance.keys(), ...spec.deprecated.keys()]) {
      if (!allIdOwners.has(itemId)) allIdOwners.set(itemId, []);
      allIdOwners.get(itemId).push(spec);
    }
  }

  const testFiles = collectTestFiles(root, policy);
  const annotations = [];
  const unannotated = [];
  const annotatedFiles = new Set();
  const skipHits = [];
  for (const file of testFiles) {
    const text = readText(file.absPath);
    const fileAnnotations = scanAnnotations(text);
    skipHits.push(...scanSkipHits(text).map((hit) => ({ relPath: file.relPath, ...hit })));
    if (fileAnnotations.length === 0) {
      unannotated.push(file.relPath);
      continue;
    }
    annotatedFiles.add(file.relPath);
    for (const annotation of fileAnnotations) annotations.push({ relPath: file.relPath, ...annotation });
  }

  const r1Violations = [];
  for (const annotation of annotations) {
    for (const itemId of annotation.ids) {
      if (deprecatedOwners.has(itemId)) {
        const owner = deprecatedOwners.get(itemId);
        r1Violations.push(
          `[已废弃] ${itemId} ← ${annotation.relPath}:${annotation.line} (见 ${owner.relPath}:${owner.deprecated.get(itemId)})\n` +
          '      验收项已显式废弃（语义翻转/裁断废弃）——按新口径改写断言并改标新 ID，或删测试',
        );
      } else if (!activeIdOwners.has(itemId)) {
        const terminalOwner = (allIdOwners.get(itemId) ?? []).find((spec) => terminalStatuses.has(spec.status));
        if (terminalOwner) {
          r1Violations.push(
            `[已随 spec 退役] ${itemId} ← ${annotation.relPath}:${annotation.line} (见 ${terminalOwner.relPath})\n` +
            `      验收项所属 spec status=${terminalOwner.status}——查取代 spec 的新 ID 或删测试`,
          );
        } else {
          r1Violations.push(
            `[未定义] ${itemId} ← ${annotation.relPath}:${annotation.line}\n` +
            '      ID 全仓未定义（拼写错误或验收项从未存在）——修标注或补 spec 验收项',
          );
        }
      }
    }
  }

  const r2Errors = [];
  const r2Warnings = [];
  for (const [itemId, owners] of allIdOwners) {
    const activeOwners = owners.filter((spec) => activeStatuses.has(spec.status));
    if (activeOwners.length > 1) {
      r2Errors.push(`ID ${itemId} 在 ${activeOwners.length} 份 Active 产物中重复定义: ${activeOwners.map((spec) => spec.relPath).join(', ')}`);
    } else if (owners.length > activeOwners.length) {
      r2Warnings.push(`ID ${itemId} 终态与 Active 重号（编号复用嫌疑）: ${owners.map((spec) => spec.relPath).join(', ')}`);
    }
  }

  const entryRegexes = (policy.entryGlobs ?? []).map(globToRegExp);
  const r4Orphans = entryRegexes.length === 0
    ? null
    : testFiles
      .filter((file) => !entryRegexes.some((regex) => regex.test(file.relPath)))
      .map((file) => file.relPath);

  const seamMock = policy.seamMock;
  const r10Violations = [];
  if (seamMock) {
    for (const file of testFiles) {
      if (!file.relPath.toLowerCase().includes(seamMock.fileNamePattern)) continue;
      for (const violation of scanSeamMockViolations(readText(file.absPath), seamMock)) {
        r10Violations.push(`${file.relPath}:${violation.line}  ${violation.text.slice(0, 100)}\n      seam 内模块级 mock——合法替身打豁免标记 ${seamMock.exemptMarker}，桩被测链路则重构`);
      }
    }
  }

  const annotatedIds = new Set();
  for (const annotation of annotations) {
    for (const itemId of annotation.ids) annotatedIds.add(itemId);
  }
  const covered = [...activeIdOwners.keys()].filter((itemId) => annotatedIds.has(itemId)).length;

  const errors = [...r1Violations.map((text) => `R1 ${text}`), ...r2Errors.map((text) => `R2 ${text}`)];
  if (seamMock?.level === 'error') {
    errors.push(...r10Violations.map((text) => `R10 ${text}`));
  }

  console.log(
    `test-linkage 读数: Active 验收 ID ${activeIdOwners.size} | 测试标注 ${annotations.length} 处 / 测试文件 ${testFiles.length} 个 | ` +
    `标注覆盖 ${covered} 个验收 ID (代理读数，未覆盖 ≠ 未实现) | 无标注测试文件 ${unannotated.length} 个`,
  );

  const warn = (message) => console.log(`[warn] ${message}`);
  for (const text of r2Warnings) warn(`R2 ${text}`);
  if (r10Violations.length > 0 && seamMock?.level !== 'error') {
    warn(`R10 seam mock ${r10Violations.length} 处:`);
    for (const text of r10Violations) warn(text);
  }
  if (r4Orphans === null) {
    warn('R4 跳过：policy 未配置 entryGlobs 运行入口清单');
  } else if (r4Orphans.length > 0) {
    warn(`R4 孤儿测试文件 ${r4Orphans.length} 个（不被任何运行入口覆盖）:`);
    for (const relPath of r4Orphans.slice(0, 20)) warn(`  - ${relPath}`);
    if (r4Orphans.length > 20) warn(`  ... 共 ${r4Orphans.length} 个`);
  }
  if (skipHits.length > 0) {
    warn(`R5 skip/todo ${skipHits.length} 处:`);
    for (const hit of skipHits.slice(0, 15)) warn(`  - ${hit.relPath}:${hit.line}  ${hit.text.slice(0, 90)}`);
    if (skipHits.length > 15) warn(`  ... 共 ${skipHits.length} 处`);
  }

  if (errors.length > 0) {
    console.error(`guard:spec-test-linkage failed (${errors.length} 项阻断违规):`);
    for (const text of errors) console.error(`  ${text}`);
    process.exit(1);
  }
  return 0;
};

process.exit(main());
