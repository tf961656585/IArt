#!/usr/bin/env node
/**
 * guard:model-input-modalities —— 参数表单的媒体上传组件 ↔ capability 模态声明一致性。
 *
 * 不变量（未变）：`parameter_schema.fields` 里出现 `imageUpload` / `videoUpload` /
 * `audioUpload` 时，`capability.input_modalities` 必须包含对应媒体类型；出现 `imageUpload`
 * 时 `capability.supports_reference_media` 必须为 true。不一致会让「表单能选图、运行时按纯文本
 * 处理」静默降级。
 *
 * 校验对象（2026-10-20 变更）：原本扫仓库内能力包源目录。模型能力包退场、
 * 包目录删除后，**族模板**成为唯一产出这类组合的地方——自建生成模型记录 × 族模板在内存里
 * 合成 sources，再经投影进目录。所以本门禁改为对族模板产出的 sources 逐族校验：族模板写错
 * 一个媒体字段，所有自建模型都会踩同一个坑，这比对照旧包更要紧。
 *
 * 覆盖两种形态：不接受任何素材位的形态，与接受全部素材位的形态。素材位决定模板是否生成
 * 媒体字段，只查一种形态会漏掉另一侧。
 *
 * 运行方式：`node --import tsx tooling/scripts/guard-model-input-modalities-consistency.mjs`
 * （族模板是 backend 的 `.cts` 源码，需要 tsx 转译；与 diagnose:model-catalog 同一手法）。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const COMPONENT_TO_MEDIA_KIND = {
  imageUpload: 'image',
  videoUpload: 'video',
  audioUpload: 'audio',
};

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asArray = (value) => (Array.isArray(value) ? value : []);

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

/** 从字段清单收集媒体类型；命中未知 upload 组件时返回告警（不阻断）。 */
const collectMediaKinds = (fields) => {
  const kinds = new Set();
  let unknownComponent = null;
  for (const field of fields) {
    if (!isRecord(field)) continue;
    const component = typeof field.component === 'string' ? field.component : '';
    if (COMPONENT_TO_MEDIA_KIND[component]) {
      kinds.add(COMPONENT_TO_MEDIA_KIND[component]);
    } else if (component.endsWith('Upload') && !COMPONENT_TO_MEDIA_KIND[component]) {
      unknownComponent = component;
    }
  }
  return { kinds, unknownComponent };
};

/** 对一份族模板 sources 跑全部不变量检查。 */
const checkSources = ({ familyAdapterId, modelId, sources }) => {
  const issues = [];
  const runtimeModel = isRecord(sources.runtimeModel) ? sources.runtimeModel : {};
  const capability = isRecord(runtimeModel.capability) ? runtimeModel.capability : {};
  const inputModalities = asArray(capability.input_modalities);
  const supportsReferenceMedia = capability.supports_reference_media;
  const parameterSchema = isRecord(runtimeModel.parameter_schema)
    ? runtimeModel.parameter_schema
    : {};
  const fields = asArray(parameterSchema.fields);

  const { kinds: requiredMediaKinds, unknownComponent } = collectMediaKinds(fields);

  if (unknownComponent !== null) {
    issues.push({
      familyAdapterId,
      modelId,
      level: 'warning',
      message: `unknown upload component '${unknownComponent}' found in parameter_schema — extend COMPONENT_TO_MEDIA_KIND mapping if needed`,
    });
  }

  for (const kind of requiredMediaKinds) {
    if (!inputModalities.includes(kind)) {
      issues.push({
        familyAdapterId,
        modelId,
        level: 'error',
        message: `parameter_schema has upload component for '${kind}' but input_modalities ${JSON.stringify(inputModalities)} does not include '${kind}'`,
      });
    }
  }

  if (requiredMediaKinds.has('image') && supportsReferenceMedia !== true) {
    issues.push({
      familyAdapterId,
      modelId,
      level: 'error',
      message: `parameter_schema has imageUpload component but supports_reference_media is ${String(supportsReferenceMedia)} (expected true)`,
    });
  }

  return issues;
};

const main = async () => {
  const registry = await loadFamilyRegistry();
  const allIssues = [];
  let checkedShapes = 0;

  for (const [familyAdapterId, entry] of Object.entries(registry)) {
    if (!isRecord(entry) || entry.status !== 'ready') continue;
    const buildBaseSources = entry.buildBaseSources;
    if (typeof buildBaseSources !== 'function') continue;
    const supportsMediaSlots = asArray(entry.supportsMediaSlots);

    // 两种形态都查：素材位决定是否生成媒体字段，单查一种会漏另一侧的错配。
    for (const acceptedMediaSlots of [[], supportsMediaSlots]) {
      const modelId = `guard-${familyAdapterId}`;
      const sources = buildBaseSources(modelId, { acceptedMediaSlots });
      allIssues.push(...checkSources({ familyAdapterId, modelId, sources }));
      checkedShapes += 1;
    }
  }

  // 一个 ready 族都没扫到 = 门禁退化成空循环恒绿，必须判红。
  if (checkedShapes === 0) {
    console.error(
      'guard:model-input-modalities failed: no ready family template found (registry scan produced zero shapes)',
    );
    process.exit(1);
  }

  const errors = allIssues.filter((issue) => issue.level === 'error');
  if (errors.length > 0) {
    console.error('guard:model-input-modalities failed:');
    for (const issue of errors) {
      console.error(`  ${issue.familyAdapterId}/${issue.modelId}: ${issue.message}`);
    }
    for (const issue of allIssues.filter((item) => item.level === 'warning')) {
      console.error(`  ${issue.familyAdapterId}/${issue.modelId}: [WARNING] ${issue.message}`);
    }
    process.exit(1);
  }

  for (const issue of allIssues) {
    if (issue.level === 'warning') {
      console.error(`  ${issue.familyAdapterId}/${issue.modelId}: [WARNING] ${issue.message}`);
    }
  }
};

main().catch((error) => {
  console.error(
    `guard:model-input-modalities failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
