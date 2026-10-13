#!/usr/bin/env node
/**
 * guard:nested-formdata-body-handled
 *
 * 静态分析 guard：确保 normalizeTaskSubmitRequestBody 函数
 * 存在对 payload.body 为 FormData 的检测路径（路径 2）。
 *
 * 检查函数体中是否包含 isFormDataLike(body) 检测。
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_POLICY_PATH = 'tooling/policies/nested-formdata-body-handled.policy.json';

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

  if (!fs.existsSync(sourceFile)) {
    console.error(`Source file not found: ${sourceFile}`);
    process.exit(1);
  }

  const source = fs.readFileSync(sourceFile, 'utf8');
  const issues = [];

  const funcBody = extractFunctionBody(source, functionName);
  if (!funcBody) {
    issues.push({
      message: `Function ${functionName} not found in ${policy.targetFunction.split('::')[0]}`,
    });
    console.error(`guard:nested-formdata-body-handled failed:`);
    for (const issue of issues) {
      console.error(`  ${issue.message}`);
    }
    process.exit(1);
  }

  // Check 1: Function accesses payload.body
  const accessesBody = funcBody.includes(`['body']`) || funcBody.includes('.body');
  if (!accessesBody) {
    issues.push({
      message: `${functionName} does not access payload.body property`,
    });
  }

  // Check 2: Function checks isFormDataLike on the body property
  const checksFormDataOnBody = funcBody.includes('isFormDataLike(body)');
  if (!checksFormDataOnBody) {
    issues.push({
      message: `${functionName} does not check isFormDataLike(body) for nested FormData path`,
    });
  }

  // Check 3: Function calls normalizeTaskSubmitArgsFromFormData on body
  const callsNormalizeOnBody = funcBody.includes('normalizeTaskSubmitArgsFromFormData(body)');
  if (!callsNormalizeOnBody) {
    issues.push({
      message: `${functionName} does not call normalizeTaskSubmitArgsFromFormData on body for nested FormData`,
    });
  }

  if (issues.length > 0) {
    console.error(`guard:nested-formdata-body-handled failed:`);
    for (const issue of issues) {
      console.error(`  ${issue.message}`);
    }
    process.exit(1);
  }
};

main();
