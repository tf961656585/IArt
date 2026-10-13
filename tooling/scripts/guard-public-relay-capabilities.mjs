#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PUBLIC_RELAY_TARGET_TYPES } = require('@iart/contracts');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const parseArgs = (argv) => {
  const options = {
    packagesDir: '',
    registryJson: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--packages-dir') {
      options.packagesDir = normalizeString(argv[index + 1]);
      index += 1;
    } else if (arg === '--registry-json') {
      options.registryJson = normalizeString(argv[index + 1]);
      index += 1;
    }
  }
  return options;
};

const readJsonFile = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const ensureRelativeChildPath = (rootDir, relativePath) => {
  const normalized = normalizeString(relativePath).replace(/\\/g, '/');
  if (!normalized || path.isAbsolute(normalized)) return null;
  const resolved = path.resolve(rootDir, normalized);
  const normalizedRoot = path.resolve(rootDir);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
};

const collectPublicUrlFromRule = (rule) => {
  if (Array.isArray(rule)) {
    return rule.some((item) => collectPublicUrlFromRule(item));
  }
  if (!isRecord(rule)) return false;
  if (normalizeString(rule.media_target) === 'public_url') return true;
  return Object.values(rule).some((value) => collectPublicUrlFromRule(value));
};

const collectPublicRelayRequirementsFromRuntime = ({ packageId, modelId, runtime }) => {
  if (!isRecord(runtime)) return [];
  const payloadRules = isRecord(runtime.payload_rules) ? runtime.payload_rules : null;
  /* 对话模型已不再由能力包承载，原来那条「chat_streaming + 本地媒体模态」的判定一并移除；
     触发条件只剩 payload_rules 里的公网 URL 字段（生成族在用）。 */
  const needsPublicRelay = Boolean(payloadRules && collectPublicUrlFromRule(payloadRules));
  if (!needsPublicRelay) return [];
  return [{
    packageId,
    modelId,
    uploadMode: normalizeString(runtime.url_input_upload_mode),
    targetType: normalizeString(runtime.url_input_upload_target_type),
  }];
};

const collectPackageRequirements = (packageDir) => {
  const packageId = path.basename(packageDir);
  const manifestPath = path.join(packageDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return {
      requirements: [],
      issues: [{
        packageId,
        modelId: '',
        code: 'manifest_missing',
        message: '缺少 manifest.json',
      }],
    };
  }
  const manifest = readJsonFile(manifestPath);
  if (!isRecord(manifest) || !isRecord(manifest.entry_model)) {
    return {
      requirements: [],
      issues: [{
        packageId,
        modelId: '',
        code: 'manifest_entry_model_invalid',
        message: 'manifest.entry_model 缺失或无效',
      }],
    };
  }
  const modelId = normalizeString(manifest.entry_model.model_id);
  const modelPath = ensureRelativeChildPath(packageDir, manifest.entry_model.relative_path);
  if (!modelPath || !fs.existsSync(modelPath)) {
    return {
      requirements: [],
      issues: [{
        packageId,
        modelId,
        code: 'entry_model_file_missing',
        message: 'entry model 文件缺失',
      }],
    };
  }
  const runtimeModel = readJsonFile(modelPath);
  const runtime = isRecord(runtimeModel) ? runtimeModel.runtime : null;
  return {
    requirements: collectPublicRelayRequirementsFromRuntime({ packageId, modelId, runtime }),
    issues: [],
  };
};

const collectRequirements = (packagesDir) => {
  if (!fs.existsSync(packagesDir) || !fs.statSync(packagesDir).isDirectory()) {
    return {
      requirements: [],
      issues: [{
        packageId: '*',
        modelId: '',
        code: 'packages_root_missing',
        message: `模型包目录不存在: ${packagesDir}`,
      }],
    };
  }
  const result = {
    requirements: [],
    issues: [],
  };
  const packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesDir, entry.name))
    .sort();
  for (const packageDir of packageDirs) {
    try {
      const collected = collectPackageRequirements(packageDir);
      result.requirements.push(...collected.requirements);
      result.issues.push(...collected.issues);
    } catch (error) {
      result.issues.push({
        packageId: path.basename(packageDir),
        modelId: '',
        code: 'package_scan_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
};

const normalizeRegistryTargets = (raw) => {
  const targets = new Map();
  if (isRecord(raw?.publicRelayTargets)) {
    for (const targetType of PUBLIC_RELAY_TARGET_TYPES) {
      const config = raw.publicRelayTargets[targetType];
      if (isRecord(config)) {
        targets.set(targetType, normalizeString(config.endpoint));
      }
    }
  }
  if (Array.isArray(raw?.targets)) {
    for (const item of raw.targets) {
      if (!isRecord(item)) continue;
      const targetType = normalizeString(item.targetType);
      if (targetType) {
        targets.set(targetType, normalizeString(item.endpoint));
      }
    }
  }
  return targets;
};

const readBackendDefaultRegistry = () => {
  const constantsPath = path.join(repoRoot, 'apps', 'backend', 'dist', 'local-server', 'constants.cjs');
  if (!fs.existsSync(constantsPath)) {
    throw new Error(
      `backend_dist_constants_missing:${constantsPath}. 请先运行 pnpm --filter @iart/backend build。`,
    );
  }
  const constants = require(constantsPath);
  return normalizeRegistryTargets(constants.DEFAULT_BACKEND_CONFIG);
};

const readRegistry = (registryJsonPath) => {
  if (registryJsonPath) {
    return normalizeRegistryTargets(readJsonFile(path.resolve(registryJsonPath)));
  }
  return readBackendDefaultRegistry();
};

/**
 * 结构对账语义（2026-10-12 拍板：公共中转端点不再内置默认、用户自带）：
 * 端点是否配置是运行时的用户配置事实，构建期守卫不检查 endpoint（空/非法都不算错）；
 * 守卫只保证「包声明的中转 targetType 在 Backend 注册表中存在」——这是拼写与契约层错误，
 * 运行期才暴露、排查成本高。
 */
const validateRequirements = (requirements, registryTargets) => {
  const issues = [];
  for (const requirement of requirements) {
    if (requirement.uploadMode !== 'public_relay') {
      issues.push({
        packageId: requirement.packageId,
        modelId: requirement.modelId,
        targetType: requirement.targetType,
        code: 'public_relay_upload_mode_missing',
        message: 'public_url 字段未声明 runtime.url_input_upload_mode=public_relay',
      });
      continue;
    }
    if (!requirement.targetType) {
      issues.push({
        packageId: requirement.packageId,
        modelId: requirement.modelId,
        targetType: '',
        code: 'public_relay_target_type_missing',
        message: 'public_url 字段缺少 runtime.url_input_upload_target_type',
      });
      continue;
    }
    if (!registryTargets.has(requirement.targetType)) {
      issues.push({
        packageId: requirement.packageId,
        modelId: requirement.modelId,
        targetType: requirement.targetType,
        code: 'public_relay_target_unsupported',
        message: `Backend public relay registry 不支持 targetType: ${requirement.targetType}`,
      });
    }
  }
  return issues;
};

const formatIssue = (issue) => [
  `package_id=${issue.packageId || '*'}`,
  `model_id=${issue.modelId || '(unknown)'}`,
  issue.targetType !== undefined ? `targetType=${issue.targetType || '(empty)'}` : null,
  `code=${issue.code}`,
  `message=${issue.message}`,
].filter(Boolean).join(' ');

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const packagesDir = path.resolve(options.packagesDir || path.join(repoRoot, '.model-assets', 'packages'));
  const collected = collectRequirements(packagesDir);
  const registryTargets = readRegistry(options.registryJson);
  const requirementIssues = validateRequirements(collected.requirements, registryTargets);
  const issues = [...collected.issues, ...requirementIssues];

  if (issues.length > 0) {
    console.error('[guard:public-relay-capabilities] failed');
    for (const issue of issues) {
      console.error(`- ${formatIssue(issue)}`);
    }
    process.exitCode = 1;
    return;
  }

  const targetTypes = [...new Set(collected.requirements.map((item) => item.targetType))]
    .filter(Boolean)
    .sort();
  console.log('[guard:public-relay-capabilities] passed');
  console.log(`- packagesDir=${packagesDir}`);
  console.log(`- publicRelayRequirements=${collected.requirements.length}`);
  console.log(`- targetTypes=${targetTypes.length > 0 ? targetTypes.join(',') : '(none)'}`);
};

main();
