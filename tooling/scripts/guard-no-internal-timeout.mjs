#!/usr/bin/env node
import {
  compilePathPolicy,
  createIssue,
  createSourceFile,
  runIssuesMain,
  ts,
} from './policy-scan-utils.mjs';

const DEFAULT_POLICY_PATH = 'tooling/policies/no-internal-timeout.policy.json';

const compilePolicy = (policy) => ({
  ...compilePathPolicy(policy),
});

const expressionText = (node, sourceFile) => node.getText(sourceFile);

const isPromiseRace = (node, sourceFile) =>
  ts.isCallExpression(node) && expressionText(node.expression, sourceFile) === 'Promise.race';

const isAbortSignalTimeout = (node, sourceFile) =>
  ts.isCallExpression(node) && expressionText(node.expression, sourceFile) === 'AbortSignal.timeout';

const isSocketSetTimeout = (node, sourceFile) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === 'setTimeout' &&
  !expressionText(node.expression.expression, sourceFile).startsWith('window');

const getName = (node) => {
  if (!node) return '';
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return '';
};

const callbackAbortsController = (node) => {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  let found = false;
  const visit = (child) => {
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      child.expression.name.text === 'abort'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node.body);
  return found;
};

const isAbortTimer = (node) =>
  ts.isCallExpression(node) &&
  getName(node.expression) === 'setTimeout' &&
  node.arguments.length > 0 &&
  callbackAbortsController(node.arguments[0]);

const scanFile = ({ absPath, relPath }) => {
  const sourceFile = createSourceFile(absPath);
  const issues = [];

  const visit = (node) => {
    if (isPromiseRace(node, sourceFile)) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          'internal/no-promise-race-timeout',
          '内部通信链路禁止用 Promise.race 实现超时。',
          '不要在项目内部通信上使用 Promise.race 超时；需要取消任务时使用显式用户取消语义。',
        ),
      );
    }

    if (isAbortSignalTimeout(node, sourceFile) || isAbortTimer(node) || isSocketSetTimeout(node, sourceFile)) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          'internal/no-timeout-abort',
          '内部通信链路禁止用超时触发 abort 或 socket timeout。',
          '移除超时 abort；内部通信应通过显式 timeoutMs 配置设置合理超时。',
        ),
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return issues;
};

runIssuesMain({
  title: 'No internal timeout gate',
  defaultPolicyPath: DEFAULT_POLICY_PATH,
  compilePolicy,
  scanFile,
});
