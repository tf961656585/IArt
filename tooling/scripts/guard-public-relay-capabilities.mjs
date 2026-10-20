#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { PUBLIC_RELAY_TARGET_TYPES } = require('@iart/contracts');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const parseArgs = (argv) => {
  const options = { registryJson: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--registry-json') {
      options.registryJson = normalizeString(argv[index + 1]);
      index += 1;
    }
  }
  return options;
};

const readJsonFile = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

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

/** 加载 backend 的族模板注册表（`.cts` 源码，需 tsx 转译）。 */
const loadFamilyRegistry = async () => {
  const modulePath = path.join(
    repoRoot,
    'apps',
    'backend',
    'src',
    'local-server',
    'generation-family-templates.registry.cts',
  );
  const loaded = await import(pathToFileURL(modulePath).href);
  const registry = loaded.GENERATION_FAMILY_TEMPLATE_REGISTRY;
  if (!isRecord(registry)) {
    throw new Error(`family_template_registry_missing:${modulePath}`);
  }
  return registry;
};

/**
 * 族模板 sources → 公网中转需求清单。
 *
 * 2026-10-20：校验对象由「已构建的能力包目录」改为「族模板产出的 sources」。族模板是现在唯一
 * 声明 `url_input_upload_mode` / `url_input_upload_target_type` 的地方（自建生成模型记录 × 族模板
 * 合成内存态 sources）；包退场后，继续要求存在物理包目录只会让门禁恒红。
 *
 * 族模板与素材位强相关：不带任何素材位的形态没有 `public_url` 媒体目标，此时不该声明
 * public_relay（声明了反而是坏包）。因此逐族按「无素材位」与「全部素材位」两种形态各取一次。
 */
const collectFamilyTemplateRequirements = (registry) => {
  const result = { requirements: [], issues: [] };
  for (const [familyAdapterId, entry] of Object.entries(registry)) {
    if (!isRecord(entry) || entry.status !== 'ready') continue;
    const buildBaseSources = entry.buildBaseSources;
    if (typeof buildBaseSources !== 'function') continue;
    const supportsMediaSlots = Array.isArray(entry.supportsMediaSlots)
      ? entry.supportsMediaSlots
      : [];
    for (const acceptedMediaSlots of [[], supportsMediaSlots]) {
      const modelId = `guard-${familyAdapterId}`;
      try {
        const sources = buildBaseSources(modelId, { acceptedMediaSlots });
        const runtimeModel = isRecord(sources) ? sources.runtimeModel : null;
        const runtime = isRecord(runtimeModel) ? runtimeModel.runtime : null;
        result.requirements.push(
          ...collectPublicRelayRequirementsFromRuntime({
            packageId: familyAdapterId,
            modelId,
            runtime,
          }),
        );
      } catch (error) {
        result.issues.push({
          packageId: familyAdapterId,
          modelId,
          code: 'family_template_build_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
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

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const registry = await loadFamilyRegistry();
  const collected = collectFamilyTemplateRequirements(registry);

  // 一个需求都没扫到 = 要么族模板不再声明公网中转（需人工确认），要么扫描逻辑失效。
  // 后者会让门禁恒绿，所以这里按失败处理并点名，避免「规则还在、只是再也不触发」。
  if (collected.requirements.length === 0 && collected.issues.length === 0) {
    console.error('[guard:public-relay-capabilities] failed');
    console.error('- code=no_public_relay_requirement_collected message=族模板扫描未产出任何公网中转需求');
    process.exitCode = 1;
    return;
  }

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
  console.log(`- source=family-templates`);
  console.log(`- publicRelayRequirements=${collected.requirements.length}`);
  console.log(`- targetTypes=${targetTypes.length > 0 ? targetTypes.join(',') : '(none)'}`);
};

main().catch((error) => {
  console.error(
    `[guard:public-relay-capabilities] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
