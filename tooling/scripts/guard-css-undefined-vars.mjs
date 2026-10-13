#!/usr/bin/env node
// CSS 未定义变量守卫
//
// 扫描原生 CSS（含 HTML 内联 <style>），拦截 var(--name) 或 var(--name, fallback)
// 中 name 在该文件内从未作为自定义属性声明过的引用。单文件闭合判定，不跨文件解析。
//
// 判定口径：
// - 定义点：任何选择器或 at-rule 块内的 `--name:` 声明都算定义（不限定 :root）。
//   覆盖 :root / [data-theme] / .dark / 组件局部变量等合法分层主题。
// - 注释剥离：先移除 /* ... */ 再扫描定义，避免注释里的 `--name:` 被误判为定义。
// - 已定义变量 + 带 fallback 的冗余写法（如 var(--accent, #2563eb)）不报错。
// - 仅对"完全未定义"的变量报错。

import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs,
  readJson,
  compilePathPolicy,
  walkFiles,
  isInZone,
} from './policy-scan-utils.mjs';

const DEFAULT_POLICY_PATH = 'tooling/policies/css-undefined-vars.policy.json';
const RULE_ID = 'css/undefined-var';

const stripCssComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');

const extractStyleBlocks = (source) => {
  // 从 HTML 中抽取所有 <style>...</style> 内容，保留原始行号映射。
  const blocks = [];
  const openTag = /<style[^>]*>/gi;
  let match;
  while ((match = openTag.exec(source)) !== null) {
    const startIndex = match.index + match[0].length;
    const closeIndex = source.indexOf('</style>', startIndex);
    if (closeIndex === -1) break;
    const content = source.slice(startIndex, closeIndex);
    const startLine = source.slice(0, startIndex).split(/\r?\n/).length;
    blocks.push({ content, startLine });
  }
  return blocks;
};

const lineAndColumnOf = (text, offset) => {
  const upTo = text.slice(0, offset);
  const lines = upTo.split(/\r?\n/);
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
};

const collectDefinitions = (commentFreeText) => {
  const defined = new Set();
  const definitionPattern = /--([A-Za-z0-9_-]+)\s*:/g;
  let match;
  while ((match = definitionPattern.exec(commentFreeText)) !== null) {
    defined.add(match[1]);
  }
  return defined;
};

const collectUndefinedReferences = ({ commentFreeText, defined, originalStartLine, runtimeInjected }) => {
  const effectiveDefined = new Set(defined);
  for (const name of runtimeInjected) effectiveDefined.add(name);
  const issues = [];
  const referencePattern = /var\(\s*--([A-Za-z0-9_-]+)/g;
  let match;
  while ((match = referencePattern.exec(commentFreeText)) !== null) {
    const name = match[1];
    if (effectiveDefined.has(name)) continue;
    const { line: relativeLine, column } = lineAndColumnOf(commentFreeText, match.index);
    issues.push({
      name,
      line: originalStartLine + relativeLine - 1,
      column,
    });
  }
  return issues;
};

const scanFile = (target, runtimeInjected) => {
  const raw = fs.readFileSync(target.absPath, 'utf8');
  const ext = path.extname(target.absPath).toLowerCase();
  const styleBlocks = ext === '.html' ? extractStyleBlocks(raw) : [{ content: raw, startLine: 1 }];

  // 单文件闭合判定：先合并文件内所有 style 块（去注释后）收集定义集，
  // 再在每个块上收集引用并保留各自行号。这样跨 <style> 块的同文件变量引用不会误报。
  const commentFreeAll = styleBlocks.map((block) => stripCssComments(block.content)).join('\n');
  const fileDefined = collectDefinitions(commentFreeAll);

  const issues = [];
  for (const block of styleBlocks) {
    const blockIssues = collectUndefinedReferences({
      commentFreeText: stripCssComments(block.content),
      defined: fileDefined,
      originalStartLine: block.startLine,
      runtimeInjected,
    });
    for (const issue of blockIssues) {
      issues.push({
        relPath: target.relPath,
        line: issue.line,
        column: issue.column,
        rule: RULE_ID,
        message: `引用了未定义的 CSS 变量 --${issue.name}`,
        suggestion: `在 :root 或对应主题块中声明 --${issue.name}，或改用已定义的语义变量。`,
      });
    }
  }
  return issues;
};

const formatIssue = (issue) =>
  `${issue.relPath}:${issue.line}:${issue.column} ${issue.rule} ${issue.message}\n  建议: ${issue.suggestion}`;

const run = () => {
  const args = parseArgs(process.argv.slice(2), { policy: DEFAULT_POLICY_PATH });
  const root = path.resolve(args.root);
  const policyPath = path.resolve(root, args.policy);
  const policyJson = readJson(policyPath);
  const policy = compilePathPolicy(policyJson);
  const runtimeInjected = policyJson.runtimeInjectedVars ?? [];
  const targets = walkFiles(root, policy).filter((target) => isInZone(target.relPath, policy));

  const issues = targets.flatMap((target) => scanFile(target, runtimeInjected));
  if (issues.length === 0) return 0;

  console.error(`guard:css-undefined-vars failed: 发现 ${issues.length} 处未定义 CSS 变量引用`);
  for (const issue of issues) {
    console.error(formatIssue(issue));
  }
  return 1;
};

process.exitCode = run();
