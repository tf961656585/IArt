#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd());

const TARGETS = {
  models: path.join(repoRoot, 'apps', 'editor', 'src', 'features', 'models'),
  templates: path.join(repoRoot, 'apps', 'editor', 'src', 'features', 'canvas', 'templates'),
  canvasRuntime: path.join(repoRoot, 'apps', 'editor', 'src', 'features', 'canvas'),
  locales: path.join(repoRoot, 'apps', 'editor', 'src', 'client', 'locales'),
};

const CODE_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']);

const DISALLOWED_IDENTIFIER_PATTERNS = [
  { rule: 'legacy-constant:MODEL_OPTIONS', regex: /\bMODEL_OPTIONS\b/g },
  { rule: 'legacy-constant:DEFAULT_MODEL', regex: /\bDEFAULT_MODEL\b/g },
  { rule: 'legacy-constant:MODEL_PROFILES', regex: /\bMODEL_PROFILES\b/g },
];

const DISALLOWED_REFERENCE_PATTERNS = [
  { rule: 'path-ref:generators', regex: /(?:@\/features\/models\/|\.\.\/|\.\/|\/)generators\//g },
  { rule: 'path-ref:processors/suno', regex: /processors\/suno(?:\/|['"`])/g },
];

const DISALLOWED_API_ENDPOINT_PATTERN = {
  rule: 'static-field:api.endpoint',
  regex: /\bapi\.endpoint\b/g,
};

const MODELS_LOCAL_PROCESSOR_SEGMENT = '/apps/editor/src/features/models/processors/local/';
const ALLOWED_MODEL_ID_LITERALS = new Set([
  '__template-runtime-model__',
  'edge-detect',
]);

const I18N_DISALLOWED_KEYS = new Set([
  'MODEL_OPTIONS',
  'DEFAULT_MODEL',
  'MODEL_PROFILES',
  'modelOptions',
  'defaultModel',
  'modelProfiles',
  'modelOptionGroups',
  'modelCards',
  'providerModels',
]);

const I18N_MODEL_SPECIFIC_BLOCK_PATTERN = /^(models?|providers?|modelProfiles?|modelOptions?|defaultModel)$/i;

function toRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function isCommentOnlyLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*/')
  );
}

function isTestFile(relativePath) {
  return (
    relativePath.includes('/__tests__/') ||
    /\.test\.[cm]?[jt]sx?$/i.test(relativePath) ||
    /\.spec\.[cm]?[jt]sx?$/i.test(relativePath)
  );
}

async function listFiles(dir) {
  const out = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }

  return out.sort();
}

function collectLineMatches({
  content,
  filePath,
  rule,
  regex,
  findings,
  ignoreCommentOnly = false,
}) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (ignoreCommentOnly && isCommentOnlyLine(line)) continue;
    const copied = new RegExp(regex.source, regex.flags);
    if (!copied.test(line)) continue;
    findings.push({
      rule,
      file: filePath,
      line: i + 1,
      snippet: line.trim().slice(0, 200),
    });
  }
}

function shouldAllowModelIdLiteral(relativePath, modelIdLiteral) {
  if (isTestFile(relativePath)) return true;
  if (relativePath.includes(MODELS_LOCAL_PROCESSOR_SEGMENT)) return true;
  if (ALLOWED_MODEL_ID_LITERALS.has(modelIdLiteral)) return true;
  return false;
}

function collectModelIdLiteralFindings(content, relativePath, findings) {
  const lines = content.split(/\r?\n/);
  const modelIdPattern = /\bmodelId\s*:\s*['"`]([^'"`]+)['"`]/g;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (isCommentOnlyLine(line)) continue;
    let match;
    while ((match = modelIdPattern.exec(line)) !== null) {
      const literal = match[1] ?? '';
      if (shouldAllowModelIdLiteral(relativePath, literal)) continue;
      findings.push({
        rule: 'hardcoded-modelId',
        file: relativePath,
        line: i + 1,
        snippet: line.trim().slice(0, 200),
      });
    }
  }
}

function collectPathFindings(relativePath, findings) {
  if (relativePath.includes('/generators/')) {
    findings.push({
      rule: 'path:generators-dir',
      file: relativePath,
      line: null,
      snippet: relativePath,
    });
  }

  if (relativePath.includes('/processors/suno/')) {
    findings.push({
      rule: 'path:processors/suno-dir',
      file: relativePath,
      line: null,
      snippet: relativePath,
    });
  }
}

function collectI18nFindings(parsedJson, relativePath, findings) {
  const walk = (node, keyPath) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...keyPath, String(index)]));
      return;
    }

    if (!node || typeof node !== 'object') return;

    const isModelWorkspaceScope = keyPath.includes('modelWorkspace');

    for (const [key, value] of Object.entries(node)) {
      const nextPath = [...keyPath, key];
      const normalizedPath = nextPath.join('.');

      if (I18N_DISALLOWED_KEYS.has(key)) {
        findings.push({
          rule: 'i18n-model-specific-block',
          file: relativePath,
          line: null,
          snippet: normalizedPath,
        });
      }

      if (isModelWorkspaceScope && I18N_MODEL_SPECIFIC_BLOCK_PATTERN.test(key)) {
        findings.push({
          rule: 'i18n-model-workspace-model-block',
          file: relativePath,
          line: null,
          snippet: normalizedPath,
        });
      }

      walk(value, nextPath);
    }
  };

  walk(parsedJson, []);
}

async function validateCodeFiles(files, findings) {
  for (const file of files) {
    const relativePath = `/${toRelative(file)}`;
    const ext = path.extname(file).toLowerCase();
    if (!CODE_FILE_EXTENSIONS.has(ext)) continue;
    if (isTestFile(relativePath)) continue;

    collectPathFindings(relativePath, findings);

    let content = '';
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    for (const { rule, regex } of DISALLOWED_IDENTIFIER_PATTERNS) {
      collectLineMatches({
        content,
        filePath: relativePath,
        rule,
        regex,
        findings,
        ignoreCommentOnly: false,
      });
    }

    for (const { rule, regex } of DISALLOWED_REFERENCE_PATTERNS) {
      collectLineMatches({
        content,
        filePath: relativePath,
        rule,
        regex,
        findings,
        ignoreCommentOnly: true,
      });
    }

    collectLineMatches({
      content,
      filePath: relativePath,
      rule: DISALLOWED_API_ENDPOINT_PATTERN.rule,
      regex: DISALLOWED_API_ENDPOINT_PATTERN.regex,
      findings,
      ignoreCommentOnly: true,
    });

    collectModelIdLiteralFindings(content, relativePath, findings);
  }
}

async function validateLocalePagesJson(files, findings) {
  for (const file of files) {
    if (!file.endsWith(`${path.sep}pages.json`)) continue;

    const relativePath = `/${toRelative(file)}`;
    let raw = '';
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      findings.push({
        rule: 'i18n-json-parse-failed',
        file: relativePath,
        line: null,
        snippet: 'Invalid JSON format',
      });
      continue;
    }

    collectI18nFindings(parsed, relativePath, findings);

    collectLineMatches({
      content: raw,
      filePath: relativePath,
      rule: 'i18n-legacy-pattern:MODEL_OPTIONS/DEFAULT_MODEL/MODEL_PROFILES',
      regex: /\b(MODEL_OPTIONS|DEFAULT_MODEL|MODEL_PROFILES)\b/g,
      findings,
      ignoreCommentOnly: false,
    });
  }
}

async function main() {
  const findings = [];

  const [modelFiles, templateFiles, canvasRuntimeFiles, localeFiles] = await Promise.all([
    listFiles(TARGETS.models),
    listFiles(TARGETS.templates),
    listFiles(TARGETS.canvasRuntime),
    listFiles(TARGETS.locales),
  ]);

  await validateCodeFiles([...new Set([...modelFiles, ...templateFiles, ...canvasRuntimeFiles])], findings);
  await validateLocalePagesJson(localeFiles, findings);

  if (findings.length === 0) {
    console.log('✅ editor 远端模型静态真相回流守卫通过');
    return;
  }

  console.error('❌ editor 远端模型静态真相回流守卫失败，命中以下风险：');
  for (const item of findings) {
    const linePart = item.line ? `:${item.line}` : '';
    console.error(`- [${item.rule}] ${item.file}${linePart}`);
    if (item.snippet) {
      console.error(`  ${item.snippet}`);
    }
  }
  process.exit(1);
}

main().catch((error) => {
  console.error('❌ 守卫脚本执行异常', error);
  process.exit(1);
});
