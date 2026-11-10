#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const DEFAULT_POLICY_PATH = 'tooling/policies/stable-business-types.policy.json';
const DEFAULT_ROOT = process.cwd();

const parseArgs = (argv) => {
  const args = {
    root: DEFAULT_ROOT,
    policy: DEFAULT_POLICY_PATH,
    fixtures: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--root') {
      args.root = path.resolve(argv[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (item === '--policy') {
      args.policy = argv[index + 1] ?? DEFAULT_POLICY_PATH;
      index += 1;
      continue;
    }
    if (item === '--fixture') {
      args.fixtures.push(argv[index + 1] ?? '');
      index += 1;
    }
  }

  return args;
};

const toPosix = (value) => value.split(path.sep).join('/');

const escapeRegExp = (value) => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');

const globToRegExp = (pattern) => {
  const normalized = toPosix(pattern).replace(/^\.?\//, '');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      const after = normalized[index + 2];
      if (after === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

// 开放 Record 的豁免只来自「文件路径 + 精确类型名」的显式登记（2026-11-07 拍板：
// 命名通配豁免退役——类型叫 *Result/*Params 就能放行，等于改个名即可绕过规则）。
const compileOpenRecordRegistry = (entries) => {
  const registry = new Map();
  for (const entry of entries ?? []) {
    const relPath = toPosix(entry?.path ?? '');
    const types = entry?.types ?? [];
    const reason = String(entry?.reason ?? '').trim();
    if (!relPath) throw new Error('registeredOpenRecords 登记缺少 path');
    if (!Array.isArray(types) || types.length === 0) throw new Error(`registeredOpenRecords 缺少 types：${relPath}`);
    if (!reason) throw new Error(`registeredOpenRecords 缺少 reason：${relPath}`);
    for (const type of types) {
      if (typeof type !== 'string' || type.includes('*')) {
        throw new Error(`命名通配豁免已退役：「${relPath}」的登记项 ${type} 必须写精确类型名`);
      }
      const bucket = registry.get(relPath) ?? new Set();
      if (bucket.has(type)) throw new Error(`registeredOpenRecords 重复登记：${relPath} ${type}`);
      bucket.add(type);
      registry.set(relPath, bucket);
    }
  }
  return registry;
};

const compilePolicy = (policy) => ({
  stableZones: (policy.stableZones ?? []).map((item) => toPosix(item).replace(/\/$/, '')),
  boundaryZones: (policy.boundaryZones ?? []).map(globToRegExp),
  ignorePaths: (policy.ignorePaths ?? []).map(globToRegExp),
  registeredOpenRecords: compileOpenRecordRegistry(policy.registeredOpenRecords),
  allowedFixedFieldObjects: policy.allowedFixedFieldObjects ?? [],
  fileExtensions: new Set(policy.fileExtensions ?? ['.ts', '.tsx', '.cts', '.mts']),
});

const matchesNamePattern = (name, pattern) => {
  if (pattern === name) return true;
  if (!pattern.includes('*')) return false;
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return regex.test(name);
};

const matchesObjectPattern = (text, pattern) => {
  if (pattern.startsWith('*.')) return text.endsWith(pattern.slice(1));
  return matchesNamePattern(text, pattern);
};

const isIgnored = (relPath, policy) => policy.ignorePaths.some((regex) => regex.test(relPath));

const isBoundary = (relPath, policy) => policy.boundaryZones.some((regex) => regex.test(relPath));

const isStable = (relPath, policy) => {
  if (isIgnored(relPath, policy) || isBoundary(relPath, policy)) return false;
  return policy.stableZones.some((zone) => relPath === zone || relPath.startsWith(`${zone}/`));
};

const walkFiles = (root, policy) => {
  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = toPosix(path.relative(root, absPath));
      if (!relPath || relPath.startsWith('..') || isIgnored(relPath, policy)) continue;
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (entry.isFile() && policy.fileExtensions.has(path.extname(entry.name)) && isStable(relPath, policy)) {
        files.push({ absPath, relPath });
      }
    }
  }

  return files.sort((left, right) => left.relPath.localeCompare(right.relPath));
};

const getLineAndCharacter = (sourceFile, node) => {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
};

const createIssue = (sourceFile, relPath, node, rule, message, suggestion) => {
  const position = getLineAndCharacter(sourceFile, node);
  return {
    relPath,
    line: position.line,
    column: position.column,
    rule,
    message,
    suggestion,
  };
};

const getIdentifierName = (node) => {
  if (!node) return '';
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return '';
};

const getDeclarationName = (node) => {
  let current = node;
  while (current) {
    if (
      (ts.isTypeAliasDeclaration(current) ||
        ts.isInterfaceDeclaration(current) ||
        ts.isClassDeclaration(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isVariableDeclaration(current) ||
        ts.isPropertySignature(current) ||
        ts.isPropertyDeclaration(current) ||
        ts.isParameter(current)) &&
      current.name
    ) {
      return getIdentifierName(current.name);
    }
    current = current.parent;
  }
  return '';
};

const getRecordTypeArguments = (node) => {
  if (ts.isTypeReferenceNode(node) && node.typeName.getText() === 'Record') {
    return node.typeArguments ?? [];
  }
  if (ts.isExpressionWithTypeArguments(node) && node.expression.getText() === 'Record') {
    return node.typeArguments ?? [];
  }
  return null;
};

const isRecordStringUnknown = (node) => {
  const typeArguments = getRecordTypeArguments(node);
  if (!typeArguments) return false;
  const [keyType, valueType] = typeArguments;
  return keyType?.kind === ts.SyntaxKind.StringKeyword && valueType?.kind === ts.SyntaxKind.UnknownKeyword;
};

const isStringUnknownIndexSignature = (node) => {
  if (!ts.isIndexSignatureDeclaration(node)) return false;
  const [parameter] = node.parameters;
  return parameter?.type?.kind === ts.SyntaxKind.StringKeyword && node.type.kind === ts.SyntaxKind.UnknownKeyword;
};

const isStringLiteralElementAccess = (node) =>
  ts.isElementAccessExpression(node) &&
  ts.isStringLiteralLike(node.argumentExpression) &&
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.argumentExpression.text);

const shouldAllowRecord = (node, policy, relPath) => {
  const declarationName = getDeclarationName(node);
  if (!declarationName) return false;
  // 转换助手（is/to/read/parse/normalize + ...Record|Object）返回开放形状是函数职责，
  // 不是类型命名豁免；类型侧只认登记表。
  if (/^(is|as|to|read|parse|normalize)[A-Z].*(Record|Object)$/.test(declarationName)) return true;
  return policy.registeredOpenRecords.get(relPath)?.has(declarationName) ?? false;
};

const shouldAllowFixedFieldAccess = (node, sourceFile, policy) => {
  const objectText = node.expression.getText(sourceFile);
  return policy.allowedFixedFieldObjects.some((pattern) => matchesObjectPattern(objectText, pattern));
};

const scanFile = ({ absPath, relPath }, policy) => {
  const sourceText = fs.readFileSync(absPath, 'utf8');
  const sourceFile = ts.createSourceFile(absPath, sourceText, ts.ScriptTarget.Latest, true);
  const issues = [];

  const visit = (node) => {
    if (isRecordStringUnknown(node) && !shouldAllowRecord(node, policy, relPath)) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          'stable/no-naked-record-string-unknown',
          '稳定业务区禁止裸 Record<string, unknown>。',
          '为内部结构声明固定字段类型；确需开放形状时，在 tooling/policies/stable-business-types.policy.json 的 registeredOpenRecords 按「文件 + 精确类型名 + 理由」登记。',
        ),
      );
    }

    if (isStringUnknownIndexSignature(node) && !shouldAllowRecord(node, policy, relPath)) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          'stable/no-string-unknown-index-signature',
          '稳定业务区禁止裸 string -> unknown 索引签名。',
          '改为固定字段类型；key 天然开放时同样走 registeredOpenRecords 登记（禁止按命名通配放行）。',
        ),
      );
    }

    if (
      isStringLiteralElementAccess(node) &&
      !shouldAllowFixedFieldAccess(node, sourceFile, policy)
    ) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          'stable/no-fixed-field-bracket-access',
          `稳定业务区禁止用 ["${node.argumentExpression.text}"] 访问固定字段。`,
          '补齐固定字段类型后使用点访问；真正动态字段应使用变量 key。',
        ),
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return issues;
};

const formatIssue = (issue) =>
  `${issue.relPath}:${issue.line}:${issue.column} ${issue.rule} ${issue.message}\n  建议: ${issue.suggestion}`;

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const policyPath = path.resolve(root, args.policy);
  const policy = compilePolicy(readJson(policyPath));

  const targets =
    args.fixtures.length > 0
      ? args.fixtures.map((fixture) => {
          const absPath = path.resolve(root, fixture);
          return { absPath, relPath: toPosix(path.relative(root, absPath)) };
        })
      : walkFiles(root, policy);

  const issues = targets.flatMap((target) => {
    const relPath = target.relPath;
    if (!isStable(relPath, policy)) return [];
    return scanFile(target, policy);
  });

  if (issues.length === 0) return;

  console.error('Stable business type gate failed:');
  for (const issue of issues) {
    console.error(formatIssue(issue));
  }
  process.exit(1);
};

main();
