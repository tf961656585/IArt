#!/usr/bin/env node
/**
 * guard:no-structural-fields-in-normalized-arguments
 *
 * 静态分析 guard：确保 normalizeTaskSubmitRequestBody 函数
 * 在所有路径中剔除结构字段（body、api、meta）。
 *
 * 检查：
 * 1. 函数体中存在 SCHEMA_GENERATION_PAYLOAD_STRUCTURAL_KEYS 常量
 * 2. 函数体中存在 stripStructuralKeysFromArgs 或内联剔除逻辑
 * 3. 所有 forbidden key 被引用
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_POLICY_PATH = 'tooling/policies/no-structural-fields-in-normalized-arguments.policy.json';

const parseArgs = (argv) => {
  const args = { root: process.cwd(), policy: DEFAULT_POLICY_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') { args.root = path.resolve(argv[i + 1] ?? ''); i += 1; }
    if (argv[i] === '--policy') { args.policy = argv[i + 1] ?? DEFAULT_POLICY_PATH; i += 1; }
  }
  return args;
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

/**
 * Extract function body by brace matching from source.
 * Finds `export const functionName` then matches braces to get the full body.
 */
const extractFunctionBody = (source, functionName) => {
  const decl = `export const ${functionName}`;
  const startIdx = source.indexOf(decl);
  if (startIdx < 0) return null;

  const arrowIdx = source.indexOf('=>', startIdx);
  if (arrowIdx < 0) return null;

  const firstBrace = source.indexOf('{', arrowIdx);
  if (firstBrace < 0) return null;

  let depth = 0;
  for (let i = firstBrace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIdx, i + 1);
      }
    }
  }
  return null;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const policyPath = path.resolve(root, args.policy);
  const policy = readJson(policyPath);

  const sourceFile = path.resolve(root, policy.targetFunction.split('::')[0]);
  const functionName = policy.targetFunction.split('::')[1];
  const forbiddenKeys = policy.forbiddenArgKeys;

  if (!fs.existsSync(sourceFile)) {
    console.error(`Source file not found: ${sourceFile}`);
    process.exit(1);
  }

  const source = fs.readFileSync(sourceFile, 'utf8');
  const issues = [];

  // Check 1: SCHEMA_GENERATION_PAYLOAD_STRUCTURAL_KEYS constant exists in file
  const hasStructuralKeysConst = source.includes('SCHEMA_GENERATION_PAYLOAD_STRUCTURAL_KEYS');
  if (!hasStructuralKeysConst) {
    issues.push({
      message: `Missing SCHEMA_GENERATION_PAYLOAD_STRUCTURAL_KEYS constant in ${policy.targetFunction.split('::')[0]}`,
    });
  }

  // Check 2: structural key stripping mechanism exists (function or inline filtering)
  const hasStripFunction = source.includes('stripStructuralKeysFromArgs');
  const hasInlineStructuralKeyFilter = source.includes('SCHEMA_GENERATION_PAYLOAD_STRUCTURAL_KEYS.has');
  if (!hasStripFunction && !hasInlineStructuralKeyFilter) {
    issues.push({
      message: `Missing stripStructuralKeysFromArgs function or inline SCHEMA_GENERATION_PAYLOAD_STRUCTURAL_KEYS.has filtering in ${policy.targetFunction.split('::')[0]}`,
    });
  }

  // Check 3: All forbidden keys are referenced in the file
  for (const key of forbiddenKeys) {
    if (!source.includes(`'${key}'`) && !source.includes(`"${key}"`)) {
      issues.push({
        message: `Forbidden key '${key}' not found in structural field definitions`,
      });
    }
  }

  // Check 4: Extract and verify function body
  const funcBody = extractFunctionBody(source, functionName);
  if (!funcBody) {
    issues.push({
      message: `Function ${functionName} not found in ${policy.targetFunction.split('::')[0]}`,
    });
  } else {
    const usesStripOrInline =
      funcBody.includes('stripStructuralKeysFromArgs') ||
      funcBody.includes('SCHEMA_GENERATION_PAYLOAD_STRUCTURAL_KEYS.has');
    if (!usesStripOrInline) {
      issues.push({
        message: `${functionName} does not use stripStructuralKeysFromArgs or inline structural key filtering`,
      });
    }
  }

  if (issues.length > 0) {
    console.error(`guard:no-structural-fields-in-normalized-arguments failed:`);
    for (const issue of issues) {
      console.error(`  ${issue.message}`);
    }
    process.exit(1);
  }
};

main();
