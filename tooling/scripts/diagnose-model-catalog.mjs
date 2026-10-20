#!/usr/bin/env node
/**
 * 诊断入口：一条命令看清"用户实际能在生成入口选到哪些模型"。
 *
 * 用法：`pnpm diagnose:model-catalog`
 *
 * 模型唯一来源是用户模型记录（spec 03 PC-15），因此本脚本只回答两类事实：
 *   1. 用户建了哪些生成模型记录（config/custom-generation-models.json）；
 *   2. 这些记录里哪些进得了可提交目录——准入判据只有一条：记录的 `family_adapter_id`
 *      指向一个**已就绪**的族模板；其余逐条给出不进目录的原因。
 *
 * 定位用途，不是放行入口：排查"某个模型为什么选不到"时先跑它。
 * 事实源是 backend 的 `model-catalog-entry.cts`（与可执行目录路由共用同一投影），
 * 本脚本不得复制族判据、也不得按 model_id 正则推断族归属。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const { listExecutableCatalogEntries } = require(
  path.join(repoRoot, "apps/backend/src/local-server/model-catalog-entry.cts"),
);
const { listCustomGenerationModels } = require(
  path.join(repoRoot, "apps/backend/src/local-server/provider-connection/custom-generation-model-store.cts"),
);
const { getFamilyTemplate } = require(
  path.join(repoRoot, "apps/backend/src/local-server/generation-family-templates.registry.cts"),
);

const records = listCustomGenerationModels();
const entries = listExecutableCatalogEntries();
const inCatalog = new Set(entries.map((entry) => entry.model_id));

console.log(`生成模型记录: ${records.length}`);
console.log(`可提交目录合计: ${entries.length}`);

for (const entry of entries) {
  const status = entry.deployment.deployable ? "可提交" : `不可提交(${entry.deployment.failure_code})`;
  console.log(`  - ${entry.model_id} — ${status}`);
}

const remaining = records.filter((record) => !inCatalog.has(record.model_id));
console.log(`\n记录未进可提交目录: ${remaining.length}`);
for (const record of remaining) {
  const template = getFamilyTemplate(record.family_adapter_id);
  const reason = template === null
    ? "族模板未登记（family_adapter_id 非法）"
    : template.status !== "ready"
      ? `族模板未就绪(${record.family_adapter_id})`
      : "记录存在但投影构建失败（看 backend 日志 generation-declaration-projection）";
  console.log(`  - ${record.model_id} — ${reason}`);
}
