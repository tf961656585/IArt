#!/usr/bin/env node
import {
  compilePathPolicy,
  createIssue,
  createSourceFile,
  runIssuesMain,
  ts,
} from './policy-scan-utils.mjs';

const DEFAULT_POLICY_PATH = 'tooling/policies/ipc-contract-parse.policy.json';

const compilePolicy = (policy) => ({
  ...compilePathPolicy(policy),
  allowAssertedTypeSuffixes: policy.allowAssertedTypeSuffixes ?? [],
});

const getTypeText = (node, sourceFile) => node.type.getText(sourceFile);

const nodeContainsIpc = (node, sourceFile) =>
  /ipcRenderer\.invoke|ipcMain\.handle|window\.electron|electron\?|getBrowserElectronBridge|ElectronBridge/.test(
    node.getText(sourceFile),
  );

const isInsideIpcContext = (node, sourceFile) => {
  let current = node;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (
      ts.isSourceFile(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isVariableStatement(current)
    ) {
      if (nodeContainsIpc(current, sourceFile)) return true;
    }
    current = current.parent;
  }
  return false;
};

const isForbiddenContractAssertion = (node, sourceFile, policy) => {
  if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return false;
  if (!isInsideIpcContext(node, sourceFile)) return false;
  const typeText = getTypeText(node, sourceFile);
  if (!/(Request|Response|Result)(?:[>\]\s&|,)]|$)/.test(typeText)) return false;
  return !policy.allowAssertedTypeSuffixes.some((suffix) => new RegExp(`${suffix}(?:[>\\]\\s&|,)]|$)`).test(typeText));
};

const isIpcInvoke = (node, sourceFile) =>
  ts.isCallExpression(node) && node.expression.getText(sourceFile).endsWith('ipcRenderer.invoke');

const isIpcHandle = (node, sourceFile) =>
  ts.isCallExpression(node) && node.expression.getText(sourceFile).endsWith('ipcMain.handle');

const hasParseNearby = (node, sourceFile) => {
  let current = node;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const text = current.getText(sourceFile);
    if (/Schema\.parse\s*\(/.test(text) || /\.parse\s*\(\s*await\s+/.test(text)) return true;
    current = current.parent;
  }
  return false;
};

const scanFile = ({ absPath, relPath }, policy) => {
  const sourceFile = createSourceFile(absPath);
  const issues = [];

  const visit = (node) => {
    if (isForbiddenContractAssertion(node, sourceFile, policy)) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          'ipc/no-contract-assertion',
          'IPC 边界禁止用 as ...Request/Response/Result 作为跨边界事实源。',
          '改为从 packages/contracts 导入 Zod schema 并在边界使用 .parse()。',
        ),
      );
    }

    if ((isIpcInvoke(node, sourceFile) || isIpcHandle(node, sourceFile)) && !hasParseNearby(node, sourceFile)) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          'ipc/require-contract-parse',
          'IPC invoke/handle 边界必须能看到 contracts schema parse。',
          '在 preload/bridge/handler 消费端对 request 或 response 使用 packages/contracts schema .parse()。',
        ),
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return issues;
};

runIssuesMain({
  title: 'IPC contract parse gate',
  defaultPolicyPath: DEFAULT_POLICY_PATH,
  compilePolicy,
  scanFile,
});
