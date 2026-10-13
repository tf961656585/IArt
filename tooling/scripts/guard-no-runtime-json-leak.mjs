#!/usr/bin/env node
import {
  compilePathPolicy,
  createIssue,
  createSourceFile,
  runIssuesMain,
  ts,
} from './policy-scan-utils.mjs';

const DEFAULT_POLICY_PATH = 'tooling/policies/no-runtime-json-leak.policy.json';

const compilePolicy = (policy) => ({
  ...compilePathPolicy(policy),
  forbiddenNames: new Set(policy.forbiddenNames ?? ['metadataJson', 'requestJson', 'payloadJson']),
});

const getName = (node) => {
  if (!node) return '';
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return '';
};

const scanFile = ({ absPath, relPath }, policy) => {
  const sourceFile = createSourceFile(absPath);
  const issues = [];

  const visit = (node) => {
    const isCalledMethodName =
      ts.isPropertyAccessExpression(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.expression === node;
    if (
      !isCalledMethodName &&
      (ts.isPropertyAccessExpression(node) ||
        ts.isPropertyAssignment(node) ||
        ts.isPropertySignature(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isBindingElement(node)) &&
      policy.forbiddenNames.has(getName(node.name))
    ) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          'runtime/no-json-row-field-leak',
          '运行时 hydrated 契约消费层禁止出现 metadataJson/requestJson/payloadJson。',
          '将 JSON 字段限制在 storage row 或 row-to-view projector 内，通知、storage read、Editor/Hub 消费使用 request/metadata/media view。',
        ),
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return issues;
};

runIssuesMain({
  title: 'No runtime JSON row leak gate',
  defaultPolicyPath: DEFAULT_POLICY_PATH,
  compilePolicy,
  scanFile,
});
