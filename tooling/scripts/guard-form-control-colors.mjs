#!/usr/bin/env node
// guard:form-control-colors — 表单控件文字与占位守卫
//
// 机械执法 docs/ui-form-control-standard.md §7 的三条规则：
// - FC-001：共享控件根节点必须显式声明值文字色 text-foreground，占位色必须是
//   placeholder:text-muted-foreground（input/textarea/command-input）或
//   data-[placeholder]:text-muted-foreground（select-trigger）。
// - FC-002：业务 JSX 中，类名含 text-muted-foreground 的容器不得包含输入类控件后代；
//   控件自身也不得用 text-muted-foreground 覆盖前景色。
// - FC-003：placeholder:/data-[placeholder]: 之后的颜色类只能是 text-muted-foreground，
//   不得改用前景色或加透明度。
//
// 背景：控件文字色依赖继承时，标签容器的 muted 会同时作用于已填值与 placeholder，
// 用户无法判断字段是否填写。守卫同时锁住「控件钉色」与「标签不包控件」两层。

import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs,
  readJson,
  compilePathPolicy,
  walkFiles,
  isInZone,
  toPosix,
  getLineAndColumn,
  ts,
} from './policy-scan-utils.mjs';

const DEFAULT_POLICY_PATH = 'tooling/policies/form-control-colors.policy.json';

const RULES = {
  sharedControl: 'FC-001',
  inheritedColor: 'FC-002',
  placeholderColor: 'FC-003',
};

// 共享控件钉色事实源（相对仓库根）。data-slot 与要求 token 一一对应。
const SHARED_CONTROL_SPECS = [
  {
    file: 'packages/ui/src/input.tsx',
    slot: 'input',
    tokens: ['text-foreground', 'placeholder:text-muted-foreground'],
  },
  {
    file: 'packages/ui/src/textarea.tsx',
    slot: 'textarea',
    tokens: ['text-foreground', 'placeholder:text-muted-foreground'],
  },
  {
    file: 'packages/ui/src/select.tsx',
    slot: 'select-trigger',
    tokens: ['text-foreground', 'data-[placeholder]:text-muted-foreground'],
  },
  {
    file: 'packages/ui/src/command.tsx',
    slot: 'command-input',
    tokens: ['text-foreground', 'placeholder:text-muted-foreground'],
  },
];

// 承载值文字的控件。Switch/Checkbox 没有文字，不参与继承污染判定。
const CONTROL_TAGS = new Set([
  'Input',
  'Textarea',
  'Select',
  'SelectTrigger',
  'InputGroup',
  'InputGroupInput',
  'InputGroupTextarea',
  'CommandInput',
  'input',
  'textarea',
  'select',
]);

const MUTED_TOKEN = /^text-muted-foreground(?:\/\d+)?$/;
const PLACEHOLDER_TOKEN = /(?:^|:)(?:placeholder|data-\[placeholder\]):(.+)$/;

const collectClassTexts = (node, out) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push(node.text);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    out.push(node.head.text);
    for (const span of node.templateSpans) collectClassTexts(span.literal, out);
    return;
  }
  if (ts.isJsxExpression(node)) {
    if (node.expression) collectClassTexts(node.expression, out);
    return;
  }
  node.forEachChild((child) => collectClassTexts(child, out));
};

const classTokensOf = (openingElement) => {
  const texts = [];
  for (const property of openingElement.attributes.properties) {
    if (!ts.isJsxAttribute(property)) continue;
    if (property.name.getText() !== 'className') continue;
    if (property.initializer) collectClassTexts(property.initializer, texts);
  }
  return texts.flatMap((text) => text.split(/\s+/).filter(Boolean));
};

const attributeText = (openingElement, name) => {
  for (const property of openingElement.attributes.properties) {
    if (!ts.isJsxAttribute(property)) continue;
    if (property.name.getText() !== name) continue;
    if (property.initializer && ts.isStringLiteral(property.initializer)) {
      return property.initializer.text;
    }
  }
  return null;
};

const tagNameOf = (openingElement) => openingElement.tagName.getText();

const containsControl = (node) => {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isJsxElement(child)) {
      if (CONTROL_TAGS.has(tagNameOf(child.openingElement))) {
        found = true;
        return;
      }
      for (const item of child.children) visit(item);
      return;
    }
    if (ts.isJsxSelfClosingElement(child)) {
      if (CONTROL_TAGS.has(tagNameOf(child))) found = true;
      return;
    }
    if (ts.isJsxFragment(child)) {
      for (const item of child.children) visit(item);
      return;
    }
    if (ts.isJsxExpression(child)) {
      if (child.expression) visit(child.expression);
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};

const lastSegment = (token) => token.split(':').at(-1) ?? token;

const isValueColorMuted = (token) => {
  // 伪元素 / 任意变体 / data 属性前缀不是「值文字色」：file: 控制文件按钮、
  // selection: 控制选中反白、[&_svg…] 控制图标、data-[placeholder] 归 FC-003。
  if (token.startsWith('file:') || token.startsWith('selection:')) return false;
  if (token.startsWith('data-') || token.includes('[&')) return false;
  if (PLACEHOLDER_TOKEN.test(token)) return false;
  return MUTED_TOKEN.test(lastSegment(token));
};

const scanSourceFile = (absPath, relPath, issues) => {
  const source = fs.readFileSync(absPath, 'utf8');
  const sourceFile = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true);

  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = tagNameOf(opening);
      const tokens = classTokensOf(opening);
      const position = getLineAndColumn(sourceFile, opening);

      for (const token of tokens) {
        const match = token.match(PLACEHOLDER_TOKEN);
        if (match && match[1] !== 'text-muted-foreground') {
          issues.push({
            relPath,
            line: position.line,
            column: position.column,
            rule: RULES.placeholderColor,
            message: `占位色「${token}」不是 text-muted-foreground 原值`,
            suggestion:
              '占位只能用 placeholder:text-muted-foreground（Select 用 data-[placeholder]:text-muted-foreground），不得改用前景色或加透明度。',
          });
        }
      }

      if (CONTROL_TAGS.has(tag)) {
        const muted = tokens.find((token) => isValueColorMuted(token));
        if (muted) {
          issues.push({
            relPath,
            line: position.line,
            column: position.column,
            rule: RULES.inheritedColor,
            message: `控件自身用「${muted}」覆盖了值文字色`,
            suggestion:
              '值文字必须是 text-foreground；控件不得用 text-muted-foreground 降色（2026-10-27 接口格式页同色问题）。',
          });
        }
      } else {
        const muted = tokens.find((token) => isValueColorMuted(token));
        if (muted && containsControl(node)) {
          issues.push({
            relPath,
            line: position.line,
            column: position.column,
            rule: RULES.inheritedColor,
            message: `容器用「${muted}」设色且内部包含输入控件，控件会继承成占位色`,
            suggestion:
              '标签与控件必须是兄弟：用 apps/hub/src/components/FormField.tsx，或把 text-muted-foreground 只放到标签文字节点上。',
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
};

const checkSharedControls = (root, issues) => {
  for (const spec of SHARED_CONTROL_SPECS) {
    const absPath = path.join(root, spec.file);
    if (!fs.existsSync(absPath)) {
      issues.push({
        relPath: spec.file,
        line: 1,
        column: 1,
        rule: RULES.sharedControl,
        message: '共享控件文件不存在，无法核验值文字色',
        suggestion: '确认 packages/ui 的表单控件事实源未被移动或改名。',
      });
      continue;
    }
    const sourceFile = ts.createSourceFile(
      absPath,
      fs.readFileSync(absPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let matched = false;
    const visit = (node) => {
      if (matched) return;
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        if (attributeText(opening, 'data-slot') === spec.slot) {
          matched = true;
          const tokens = classTokensOf(opening);
          const missing = spec.tokens.filter((token) => !tokens.includes(token));
          if (missing.length > 0) {
            const position = getLineAndColumn(sourceFile, opening);
            issues.push({
              relPath: spec.file,
              line: position.line,
              column: position.column,
              rule: RULES.sharedControl,
              message: `共享控件 data-slot="${spec.slot}" 缺少 ${missing.join('、')}`,
              suggestion:
                '控件必须自己钉死 text-foreground 与占位色，不能依赖消费方容器继承（docs/ui-form-control-standard.md FC-01）。',
            });
          }
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (!matched) {
      issues.push({
        relPath: spec.file,
        line: 1,
        column: 1,
        rule: RULES.sharedControl,
        message: `未找到 data-slot="${spec.slot}" 的控件根节点`,
        suggestion: '共享控件的 data-slot 是守卫定位锚点，改名需同步 SHARED_CONTROL_SPECS。',
      });
    }
  }
};

const formatIssue = (issue) =>
  `${issue.relPath}:${issue.line}:${issue.column} ${issue.rule} ${issue.message}\n  建议: ${issue.suggestion}`;

const run = () => {
  const args = parseArgs(process.argv.slice(2), { policy: DEFAULT_POLICY_PATH });
  const root = path.resolve(args.root);
  const policyPath = path.resolve(root, args.policy);
  const policy = compilePathPolicy(readJson(policyPath));
  const issues = [];

  checkSharedControls(root, issues);

  for (const target of walkFiles(root, policy)) {
    if (!isInZone(toPosix(target.relPath), policy)) continue;
    scanSourceFile(target.absPath, target.relPath, issues);
  }

  if (issues.length === 0) return 0;

  console.error(`guard:form-control-colors failed: 发现 ${issues.length} 处表单控件颜色问题`);
  for (const issue of issues) console.error(formatIssue(issue));
  return 1;
};

process.exitCode = run();
