#!/usr/bin/env node
// guard:css-size-tokens — Hub 尺寸令牌守卫
//
// 扫描 apps/hub/src 下 .ts/.tsx 源码行，拦截 className 中的尺寸类任意值：
// text-[11px]、w-[240px]、min-h-[420px]、p-[13px]、rounded-[4px]、border-[0.5px]、
// leading-[1.5]、tracking-[0.02em]、grid-cols-[33%] 等数值型任意值。
// 尺寸必须消费字号阶梯档名（visual-design §7.1 四档 20/14/12/11，text-2xs 为 11px 令牌）
// 或 CSS 变量令牌 var(--...)。判据出处 docs/hub/visual-design.md §7.1/§8.5/§12。
//
// 口径：
// - 逐行扫描（不解析 JSX），先剥注释再匹配：块注释（含 JSX {/* */}）整段抹平并保留行号，
//   行内 // 注释做字符串感知剥离（引号内的 // 不算注释，URL 不误切）。
// - 放行：-[var(--...)] 令牌形式、grid-cols-[minmax(...)] 模板（白名单候选，输出 [allow] 提示）、
//   非数值内容（颜色、calc() 等）。
// - 白名单：policy allowedPatterns（正则）登记合法残留，命中不计违规但输出 [allow] 提示行。
//   policy 位于 tooling/policies/css-size-tokens.policy.json。

import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs,
  readJson,
  compilePathPolicy,
  walkFiles,
  isInZone,
} from './policy-scan-utils.mjs';

const DEFAULT_POLICY_PATH = 'tooling/policies/css-size-tokens.policy.json';
const RULE_ID = 'css-size-token';

// 尺寸族前缀（长项在前；配合负向前瞻断言防止 min-w 内层的 w 误配）。
const SIZE_PREFIX =
  '(?:min-w|min-h|max-w|max-h|text|rounded|size|basis|inset|bottom|border|top|left|right|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|gap|w|h|p|m)';

// 检测模式：全部先过 policy allowedPatterns 白名单闸——命中输出 [allow]，未命中计违规。
// size：text/rounded/宽高/间距/内边距/边框等数值型任意值（px|rem）。
// leading/tracking：行高与字距数值型任意值（leading 单位可选，tracking 按 px|rem|em）。
// grid-percent：grid 栏比百分比任意值。
// grid-minmax：minmax 网格模板（检测它只为输出 [allow] 登记提示；policy 白名单承载放行）。
const DETECTOR_SPECS = [
  {
    id: 'size',
    source: `(?<![\\w-])-?${SIZE_PREFIX}-\\[\\d+(?:\\.\\d+)?(?:px|rem)\\]`,
  },
  {
    id: 'leading',
    source: `(?<![\\w-])-?leading-\\[\\d+(?:\\.\\d+)?(?:px|rem|em)?\\]`,
  },
  {
    id: 'tracking',
    source: `(?<![\\w-])-?tracking-\\[\\d+(?:\\.\\d+)?(?:px|rem|em)?\\]`,
  },
  {
    id: 'grid-percent',
    source: `(?<![\\w-])-?grid-(?:cols|rows)-\\[\\d+(?:\\.\\d+)?%\\]`,
  },
  {
    id: 'grid-minmax',
    source: `(?<![\\w-])-?grid-(?:cols|rows)-\\[[^\\]]*minmax\\([^\\]]*\\)\\]`,
  },
];

// 块注释整段抹平（非换行字符替换为空格，行号不变）。覆盖 JS 块注释与 JSX {/* */}。
const blankBlockComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));

// 行内 // 注释剥离（字符串感知：引号内的 // 不算注释；每行独立，跨行模板串按行处理）。
const stripLineComment = (line) => {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && line[index + 1] === '/') return line.slice(0, index);
  }
  return line;
};

const scanFile = (target, allowlist) => {
  const raw = fs.readFileSync(target.absPath, 'utf8');
  const lines = blankBlockComments(raw).split(/\r?\n/);
  const issues = [];
  const allows = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = stripLineComment(lines[lineIndex]);
    for (const spec of DETECTOR_SPECS) {
      const regex = new RegExp(spec.source, 'g');
      let match;
      while ((match = regex.exec(line)) !== null) {
        const token = match[0];
        const entry = allowlist.find((item) => item.regex.test(token));
        if (entry) {
          allows.push({
            relPath: target.relPath,
            line: lineIndex + 1,
            column: match.index + 1,
            token,
            note: entry.note,
          });
        } else {
          issues.push({
            relPath: target.relPath,
            line: lineIndex + 1,
            column: match.index + 1,
            token,
          });
        }
      }
    }
  }
  return { issues, allows };
};

const formatIssue = (issue) =>
  `${issue.relPath}:${issue.line}:${issue.column} ${RULE_ID} 尺寸类任意值「${issue.token}」——尺寸必须消费令牌或阶梯档名（visual-design §7.1/§12）\n  建议: 改用字号阶梯档名（§7.1 四档 20/14/12/11，text-2xs 为 11px 令牌）或 CSS 变量令牌 var(--...)；如属合法残留，登记 tooling/policies/css-size-tokens.policy.json 白名单。`;

const run = () => {
  const args = parseArgs(process.argv.slice(2), { policy: DEFAULT_POLICY_PATH });
  const root = path.resolve(args.root);
  const policyPath = path.resolve(root, args.policy);
  const policyJson = readJson(policyPath);
  const policy = compilePathPolicy(policyJson);
  const allowlist = (policyJson.allowedPatterns ?? []).map((entry) => ({
    regex: new RegExp(typeof entry === 'string' ? entry : entry.pattern),
    note: typeof entry === 'string' ? '' : (entry.note ?? ''),
  }));
  const targets = walkFiles(root, policy).filter((target) => isInZone(target.relPath, policy));

  const issues = [];
  const allows = [];
  for (const target of targets) {
    const found = scanFile(target, allowlist);
    issues.push(...found.issues);
    allows.push(...found.allows);
  }

  for (const item of allows) {
    console.log(
      `[allow] ${item.relPath}:${item.line}:${item.column} ${item.token}${item.note ? ` —— ${item.note}` : ''}`,
    );
  }

  if (issues.length === 0) return 0;

  console.error(`guard:css-size-tokens failed: 发现 ${issues.length} 处尺寸类任意值`);
  for (const issue of issues) {
    console.error(formatIssue(issue));
  }
  return 1;
};

process.exitCode = run();
