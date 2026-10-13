#!/usr/bin/env node
import {
  compilePathPolicy,
  createIssue,
  createSourceFile,
  runIssuesMain,
  ts,
} from './policy-scan-utils.mjs';

const DEFAULT_POLICY_PATH = 'tooling/policies/local-media-url-resolution.policy.json';

const compilePolicy = (policy) => compilePathPolicy(policy);

const LOCAL_MEDIA_SCHEME_LITERAL = 'local-media://';

/**
 * 判断一个标识符名是否为 scope 识别谓词原子之一。
 * - isProjectRef / isStableProjectId：scope 合法性校验函数
 */
const isScopePredicateCall = (node, sourceFile) => {
  if (!ts.isCallExpression(node)) return false;
  const exprText = node.expression.getText(sourceFile);
  return exprText === 'isProjectRef' || exprText === 'isStableProjectId';
};

/**
 * 判断一个表达式是否为 `=== '__global__'` / `=== LOCAL_MEDIA_GLOBAL_REF` 二元表达式。
 * 允许左右任意顺序。
 */
const isGlobalScopeEquality = (node, sourceFile) => {
  if (!ts.isBinaryExpression(node)) return false;
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
  const leftText = node.left.getText(sourceFile);
  const rightText = node.right.getText(sourceFile);
  const globalLiterals = new Set(["'__global__'", '"__global__"', 'LOCAL_MEDIA_GLOBAL_REF']);
  return globalLiterals.has(leftText) || globalLiterals.has(rightText);
};

/**
 * 规则 1：禁止内联 scope 识别谓词组合。
 *
 * 检测 `||` 链中同时出现 scope 谓词调用（isProjectRef/isStableProjectId）
 * 与 global 相等判断（=== __global__ / === LOCAL_MEDIA_GLOBAL_REF）的组合。
 * 命中建议改用 isLocalMediaScope。
 *
 * 实现思路：找到一个 `||` BinaryExpression，递归收集其操作数链中所有
 * scope 谓词调用与 global 相等判断，若两者都存在则报 issue。
 */
const collectDisjunctOperands = (node, acc, sourceFile) => {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    collectDisjunctOperands(node.left, acc, sourceFile);
    collectDisjunctOperands(node.right, acc, sourceFile);
    return;
  }
  acc.push(node);
};

const isInlineScopePredicateCombination = (node, sourceFile) => {
  if (!ts.isBinaryExpression(node)) return false;
  if (node.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return false;

  const operands = [];
  collectDisjunctOperands(node, operands, sourceFile);

  const hasScopePredicate = operands.some((op) => isScopePredicateCall(op, sourceFile));
  const hasGlobalEquality = operands.some((op) => isGlobalScopeEquality(op, sourceFile));
  return hasScopePredicate && hasGlobalEquality;
};

/**
 * 判断字符串字面量节点是否为 'local-media://'。
 */
const isLocalMediaSchemeLiteral = (node, _sourceFile) => {
  if (ts.isStringLiteral(node)) return node.text === LOCAL_MEDIA_SCHEME_LITERAL;
  // 模板字面量（无占位符）
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text === LOCAL_MEDIA_SCHEME_LITERAL;
  return false;
};

/**
 * 判断标识符是否为 LOCAL_MEDIA_SCHEME 常量引用。
 */
const isLocalMediaSchemeIdentifier = (node, sourceFile) => {
  if (!ts.isIdentifier(node)) return false;
  return node.getText(sourceFile) === 'LOCAL_MEDIA_SCHEME';
};

/**
 * 判断节点是 'local-media://' 字面量或 LOCAL_MEDIA_SCHEME 常量引用。
 */
const refersToLocalMediaScheme = (node, sourceFile) =>
  isLocalMediaSchemeLiteral(node, sourceFile) || isLocalMediaSchemeIdentifier(node, sourceFile);

/**
 * 规则 2：禁止内联 local-media:// URL 解析。
 *
 * 检测对 'local-media://' 字面量或 LOCAL_MEDIA_SCHEME 常量做
 * .slice/.split/.indexOf/.substring 等手动解析。
 *
 * 实现思路：
 * 1. 检测 `LITERAL.length` 后跟解析方法（如 `'local-media://'.length` 后续 `.slice`）—
 *    这类模式出现在 `url.slice('local-media://'.length)`。
 * 2. 检测 PropertyAccessExpression 链：base 为 scheme 引用，member 为解析方法。
 *
 * 放行：`startsWith(scheme)` 仅判断不解析，不报。
 */
const PARSING_METHOD_NAMES = new Set(['slice', 'split', 'indexOf', 'substring', 'substr', 'charAt', 'charCodeAt', 'match', 'replace']);

const isInlineLocalMediaParsing = (node, sourceFile) => {
  // 模式 A：scheme.length（属性访问）— 作为 slice 参数出现，需在调用处检测
  // 这里直接检测 CallExpression，其 function 为 PropertyAccessExpression，
  // 且该表达式的某个参数或 base 涉及 scheme。
  if (!ts.isCallExpression(node)) return false;

  const callee = node.expression;
  // 检测 callee 是 member access 形式（如 x.slice / x.split）
  if (!ts.isPropertyAccessExpression(callee)) {
    // 也可能是 `scheme.slice(...)` 形式被包在更深层 — 但核心模式是 callee.member 为解析方法名
    return false;
  }
  const methodName = callee.name.getText(sourceFile);
  if (!PARSING_METHOD_NAMES.has(methodName)) return false;

  // 检测 base 或任一参数是否涉及 scheme 引用
  const baseTouchesScheme = refersToLocalMediaScheme(callee.expression, sourceFile);
  const argTouchesScheme = node.arguments.some((arg) => {
    // 直接字面量/标识符
    if (refersToLocalMediaScheme(arg, sourceFile)) return true;
    // `.length` 形式：arg 是 PropertyAccessExpression，其 expression 是 scheme 引用
    if (
      ts.isPropertyAccessExpression(arg)
      && arg.name.getText(sourceFile) === 'length'
      && refersToLocalMediaScheme(arg.expression, sourceFile)
    ) {
      return true;
    }
    return false;
  });

  return baseTouchesScheme || argTouchesScheme;
};

const scanFile = ({ absPath, relPath }, _policy) => {
  const sourceFile = createSourceFile(absPath);
  const issues = [];
  const visit = (node) => {
    if (isInlineScopePredicateCombination(node, sourceFile)) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          'no-inline-scope-predicate',
          '识别 local-media scope 段必须复用 isLocalMediaScope（@iart/utils/media-file-key），禁止内联组合 isProjectRef/isStableProjectId 与 === __global__。',
          '改为 import { isLocalMediaScope } 并调用。',
        ),
      );
    }
    if (isInlineLocalMediaParsing(node, sourceFile)) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          'no-inline-local-media-parsing',
          '解析 local-media:// URL 必须复用 parseLocalMediaUrl 或 extractMediaFileKey（@iart/utils/media-file-key），禁止内联 slice/split/indexOf。',
          '改为 import { parseLocalMediaUrl } 或 { extractMediaFileKey } 并调用。',
        ),
      );
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return issues;
};

runIssuesMain({
  title: 'guard:local-media-url-resolution',
  defaultPolicyPath: DEFAULT_POLICY_PATH,
  compilePolicy,
  scanFile,
});
