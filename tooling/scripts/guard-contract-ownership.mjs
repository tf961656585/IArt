#!/usr/bin/env node
import {
  compilePathPolicy,
  createIssue,
  createSourceFile,
  matchesAnyNamePattern,
  runIssuesMain,
  ts,
} from './policy-scan-utils.mjs';

const DEFAULT_POLICY_PATH = 'tooling/policies/contract-ownership.policy.json';

const compilePolicy = (policy) => ({
  ...compilePathPolicy(policy),
  ownerZones: policy.ownerZones ?? ['packages/contracts/src'],
  forbiddenLocalDeclarations: policy.forbiddenLocalDeclarations ?? [],
  allowedLocalSuffixes: policy.allowedLocalSuffixes ?? [],
  forbiddenLocalSchemaVariables: policy.forbiddenLocalSchemaVariables ?? [],
});

const getName = (node) => {
  if (!node) return '';
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return '';
};

const isDeclarationWithName = (node) =>
  ts.isInterfaceDeclaration(node) ||
  ts.isTypeAliasDeclaration(node) ||
  ts.isEnumDeclaration(node) ||
  ts.isClassDeclaration(node);

const isAllowedLocalProjection = (name, policy) =>
  policy.allowedLocalSuffixes.some((suffix) => name.endsWith(suffix)) || /Options$/.test(name);

const scanFile = ({ absPath, relPath }, policy) => {
  const sourceFile = createSourceFile(absPath);
  const issues = [];

  const visit = (node) => {
    if (isDeclarationWithName(node)) {
      const name = getName(node.name);
      if (
        name &&
        !isAllowedLocalProjection(name, policy) &&
        matchesAnyNamePattern(name, policy.forbiddenLocalDeclarations)
      ) {
        issues.push(
          createIssue(
            sourceFile,
            relPath,
            node,
            'contract/owner-is-packages-contracts',
            '跨 app/进程共享契约禁止在本地重复声明。',
            '将 RuntimeTransaction、TaskState、MCP tool、StorageRead 等共享契约上浮到 packages/contracts，或改成本地 Row/Raw/Payload/Projection/View/Input。',
          ),
        );
      }
    }

    // 检查 forbiddenLocalSchemaVariables：本地 const 变量使用 z.object 重建 contracts schema
    if (ts.isVariableDeclaration(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : '';
      if (name && policy.forbiddenLocalSchemaVariables.includes(name)) {
        const initializer = node.initializer;
        if (initializer && ts.isCallExpression(initializer)) {
          const expr = initializer.expression;
          const isZodObject =
            (ts.isPropertyAccessExpression(expr) && expr.name.text === 'object') ||
            (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'object');
          if (isZodObject) {
            issues.push(
              createIssue(
                sourceFile,
                relPath,
                node,
                'contract/local-schema-variable-redefinition',
                `本地 schema 变量 '${name}' 禁止用 z.object 重建 contracts 中已有的 schema。`,
                `从 @iart/contracts 导入对应 schema（如 TaskSubmitMediaInputSchema），不要在本地重建。`,
              ),
            );
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return issues;
};

runIssuesMain({
  title: 'Contract ownership gate',
  defaultPolicyPath: DEFAULT_POLICY_PATH,
  compilePolicy,
  scanFile,
});
