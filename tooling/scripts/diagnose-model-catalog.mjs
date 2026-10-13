#!/usr/bin/env node
/**
 * 诊断入口：一条命令看清"用户实际能在生成入口选到哪些模型"。
 *
 * 用法：`pnpm diagnose:model-catalog`
 *
 * 输出三段事实：
 *   1. 已安装模型能力包投影（`.model-assets/packages` 全量加载结果）；
 *   2. 可提交目录——命中已闭合协议族的模型，即 PromptDock 里能选到的集合；
 *   3. 未进目录的模型及原因类别（TTS / 文本 / 无族匹配）。
 *
 * 定位用途，不是放行入口：改模型包、改族匹配、排查"某个模型为什么选不到"时先跑它。
 * 族匹配事实源是 `apps/backend/src/local-server/model-family-registry.cts`（与可执行目录路由共用），
 * 本脚本不得复制正则。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageRoot = path.join(repoRoot, ".model-assets", "packages");

// 包根按脚本自身位置解析并显式注入，避免依赖调用方 cwd。
process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = packageRoot;

const { listBindableModelProjections } = require(
  path.join(repoRoot, "apps/backend/src/local-server/model-package-catalog.cts"),
);
const { CLOSED_FAMILY_ADAPTERS } = require(
  path.join(repoRoot, "apps/backend/src/local-server/model-family-registry.cts"),
);

const items = listBindableModelProjections({ baseDir: undefined });
const modelIds = items
  .map((item) => item.modelId)
  .filter((value) => typeof value === "string" && value.length > 0)
  .sort();

console.log(`包根: ${packageRoot}`);
console.log(`已安装模型投影: ${modelIds.length}`);

const matched = new Set();
let submittable = 0;
for (const family of CLOSED_FAMILY_ADAPTERS) {
  const hit = modelIds.filter((modelId) => family.match(modelId));
  for (const modelId of hit) matched.add(modelId);
  submittable += hit.length;
  console.log(`\n[${family.adapterId}] ${hit.length} 个`);
  for (const modelId of hit) console.log(`  - ${modelId}`);
}

const TTS_PATTERN = /tts/i;
const remaining = modelIds.filter((modelId) => !matched.has(modelId));
const classify = (modelId) => {
  if (TTS_PATTERN.test(modelId)) return "TTS（不在通用 Provider 目录）";
  return "无族匹配（未接入已闭合协议族；文本模型与未闭合族模型属此类）";
};

console.log(`\n可提交目录合计: ${submittable}`);
console.log(`\n未进可提交目录: ${remaining.length}`);
for (const modelId of remaining) console.log(`  - ${modelId} — ${classify(modelId)}`);
