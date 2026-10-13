#!/usr/bin/env node
/**
 * guard:media-input-source-kind-coverage
 *
 * 静态分析 guard：确保 buildMediaInputFromUploadLikeItem 的分支覆盖
 * 与 TaskSubmitMediaSourceKindSchema 枚举一致。
 *
 * 如果有 source_kind 枚举值未在函数中被处理，guard 报错并退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const DEFAULT_POLICY_PATH = 'tooling/policies/media-input-source-kind-coverage.policy.json';

const parseArgs = (argv) => {
  const args = { root: process.cwd(), policy: DEFAULT_POLICY_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') { args.root = path.resolve(argv[i + 1] ?? ''); i += 1; }
    if (argv[i] === '--policy') { args.policy = argv[i + 1] ?? DEFAULT_POLICY_PATH; i += 1; }
  }
  return args;
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const createSourceFile = (absPath) =>
  ts.createSourceFile(absPath, fs.readFileSync(absPath, 'utf8'), ts.ScriptTarget.Latest, true);

const findEnumValues = (sourceFile, schemaName) => {
  const values = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) {
      const name = node.name;
      if (ts.isIdentifier(name) && name.text === schemaName) {
        const initializer = node.initializer;
        if (initializer && ts.isCallExpression(initializer)) {
          const expr = initializer.expression;
          if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'enum') {
            const args = initializer.arguments;
            if (args && args.length > 0) {
              const firstArg = args[0];
              if (ts.isArrayLiteralExpression(firstArg)) {
                for (const element of firstArg.elements) {
                  if (ts.isStringLiteral(element)) {
                    values.push(element.text);
                  }
                }
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
};

const findHandledSourceKinds = (sourceFile, functionName) => {
  const handled = new Set();

  const visit = (node) => {
    // 找到目标函数声明
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      let name = '';
      if (ts.isFunctionDeclaration(node) && node.name) {
        name = node.name.text;
      } else if (
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name)
      ) {
        name = node.parent.name.text;
      }
      if (name === functionName) {
        collectSourceKinds(node);
        return;
      }
    }

    // 处理 const fn = () => {} 形式
    if (ts.isVariableDeclaration(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : '';
      if (name === functionName && node.initializer) {
        collectSourceKinds(node.initializer);
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  const collectSourceKinds = (fnNode) => {
    const scanNode = (n) => {
      // 检测 source_kind: 'xxx' 赋值
      if (ts.isPropertyAssignment(n)) {
        const propName = ts.isIdentifier(n.name) ? n.name.text : ts.isStringLiteral(n.name) ? n.name.text : '';
        if (propName === 'source_kind' && ts.isStringLiteral(n.initializer)) {
          handled.add(n.initializer.text);
        }
      }
      ts.forEachChild(n, scanNode);
    };
    scanNode(fnNode);
  };

  visit(sourceFile);
  return handled;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const policyPath = path.resolve(root, args.policy);
  const policy = readJson(policyPath);

  const sourceFile = path.resolve(root, policy.sourceFile);

  if (!fs.existsSync(sourceFile)) {
    console.error(`Source file not found: ${sourceFile}`);
    process.exit(1);
  }

  const sourceSource = createSourceFile(sourceFile);

  // 优先使用 policy 中显式声明的 requiredSourceKinds；若未声明则从 contract enum 读取
  let requiredKinds = policy.requiredSourceKinds;
  if (!Array.isArray(requiredKinds) || requiredKinds.length === 0) {
    const contractFile = path.resolve(root, policy.contractFile);
    if (!fs.existsSync(contractFile)) {
      console.error(`Contract file not found: ${contractFile}`);
      process.exit(1);
    }
    const contractSource = createSourceFile(contractFile);
    const enumValues = findEnumValues(contractSource, policy.schemaName);
    if (enumValues.length === 0) {
      console.error(`No enum values found for ${policy.schemaName} in ${contractFile}`);
      process.exit(1);
    }
    requiredKinds = enumValues;
  }

  const handledKinds = findHandledSourceKinds(sourceSource, policy.functionName);

  const missing = requiredKinds.filter((v) => !handledKinds.has(v));
  if (missing.length > 0) {
    console.error(
      `guard:media-input-source-kind-coverage failed:\n` +
      `  Function ${policy.functionName} in ${policy.sourceFile} does not produce source_kind values:\n` +
      missing.map((v) => `    - '${v}'`).join('\n') +
      `\n  Required source_kind values: [${requiredKinds.join(', ')}]`,
    );
    process.exit(1);
  }

  // 成功时无输出
};

main();
