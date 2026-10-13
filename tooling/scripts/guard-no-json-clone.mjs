#!/usr/bin/env node
import {
  compilePathPolicy,
  createIssue,
  createSourceFile,
  runIssuesMain,
  ts,
} from './policy-scan-utils.mjs';

const DEFAULT_POLICY_PATH = 'tooling/policies/no-json-clone.policy.json';

const compilePolicy = (policy) => compilePathPolicy(policy);

const expressionText = (node, sourceFile) => node.getText(sourceFile);

const isJsonParse = (node, sourceFile) =>
  ts.isCallExpression(node) && expressionText(node.expression, sourceFile) === 'JSON.parse';

const isJsonStringify = (node, sourceFile) =>
  ts.isCallExpression(node) && expressionText(node.expression, sourceFile) === 'JSON.stringify';

const isJsonParseStringifyClone = (node, sourceFile) => {
  if (!isJsonParse(node, sourceFile)) return false;
  const [firstArg] = node.arguments;
  return Boolean(firstArg && isJsonStringify(firstArg, sourceFile));
};

const scanFile = ({ absPath, relPath }, _policy) => {
  const sourceFile = createSourceFile(absPath);
  const issues = [];

  const visit = (node) => {
    if (isJsonParseStringifyClone(node, sourceFile)) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          'runtime/no-json-parse-stringify-clone',
          '禁止使用 JSON.parse(JSON.stringify(...)) 作为运行时对象 clone。',
          '对 JSON-compatible 值使用统一 JSON copier；对运行时对象用 Zod/projector 构造明确投影。',
        ),
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return issues;
};

runIssuesMain({
  title: 'No JSON clone gate',
  defaultPolicyPath: DEFAULT_POLICY_PATH,
  compilePolicy,
  scanFile,
});
