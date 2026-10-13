#!/usr/bin/env node
/**
 * guard:no-media-input-downgrade
 *
 * 静态分析 guard：确保 normalizeTaskSubmitArgsFromRecord 中
 * buildMediaInputFromUploadLikeItem 调用后的 if (media) { ... } else { ... }
 * 降级路径包含 console.debug 日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const DEFAULT_POLICY_PATH = 'tooling/policies/no-media-input-downgrade.policy.json';

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

/**
 * 查找 normalizeTaskSubmitArgsFromRecord 函数中所有
 * `const media = await buildMediaInputFromUploadLikeItem(...)` 之后的
 * `if (media) { ... } else { ... }` 模式，
 * 验证 else 分支包含 console.debug。
 */
const checkDowngradeBranches = (sourceFile, functionName, _innerFunctionName) => {
  const issues = [];

  const visit = (node) => {
    // 找到目标函数
    if (ts.isVariableDeclaration(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : '';
      if (name === functionName && node.initializer) {
        scanForMediaCheck(node.initializer);
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  const scanForMediaCheck = (fnBody) => {
    const scan = (n) => {
      if (!n) return;
      // 找 if 语句，其条件引用了 buildMediaInputFromUploadLikeItem 的返回值
      if (ts.isIfStatement(n)) {
        const cond = n.condition;
        // 检测条件是否为简单的标识符（如 `if (media)`）
        if (cond && ts.isIdentifier(cond)) {
          // 向上查找，确认这个标识符来自 buildMediaInputFromUploadLikeItem 调用
          const elseStmt = n.elseStatement;
          if (elseStmt) {
            const hasDebug = containsConsoleDebug(elseStmt);
            if (!hasDebug) {
              const line = sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile));
              issues.push({
                line: line.line + 1,
                message: `buildMediaInputFromUploadLikeItem 返回 null 时的降级路径缺少 console.debug 日志`,
              });
            }
          }
        }
      }

      ts.forEachChild(n, scan);
    };
    scan(fnBody);
  };

  const containsConsoleDebug = (node) => {
    let found = false;
    const scan = (n) => {
      if (ts.isCallExpression(n)) {
        const expr = n.expression;
        if (
          ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === 'console' &&
          expr.name.text === 'debug'
        ) {
          found = true;
        }
      }
      ts.forEachChild(n, scan);
    };
    scan(node);
    return found;
  };

  visit(sourceFile);
  return issues;
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

  const sf = createSourceFile(sourceFile);
  const issues = checkDowngradeBranches(sf, policy.functionName, policy.innerFunctionName);

  if (issues.length > 0) {
    console.error(`guard:no-media-input-downgrade failed:`);
    for (const issue of issues) {
      console.error(`  ${policy.sourceFile}:${issue.line}: ${issue.message}`);
    }
    process.exit(1);
  }
};

main();
