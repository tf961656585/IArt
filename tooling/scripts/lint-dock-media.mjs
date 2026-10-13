#!/usr/bin/env node
/**
 * Prompt Dock 媒体槽位校验脚本
 * - 扫描 apps/editor/src/features/models 下的 schema.ts 与 config.ts
 * - 盘点所有声明了 imageUpload/file 字段的 Schema 字段 key
 * - 盘点对应 config.ts（以及 schema 内 dockMediaSlots）里是否存在 targetField 映射
 * - 若存在未覆盖的字段，输出清单并以非零退出码结束
 */
import { promises as fs } from 'node:fs';
import { resolve, join, basename } from 'node:path';

const root = resolve(process.cwd());
const modelsDir = join(root, 'apps', 'editor', 'src', 'features', 'models');

/**
 * 递归列出目录下所有文件
 */
async function listFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * 从 schema.ts 文本中解析所有上传型字段 key
 */
function parseUploadFieldKeysFromSchema(source) {
  const keys = new Set();
  const typePattern = /type\s*:\s*"(imageUpload|file)"/g;
  let m;
  while ((m = typePattern.exec(source))) {
    const typeIndex = m.index;
    // 向前回溯，查找最近的 key: "..."
    const lookbackStart = Math.max(0, typeIndex - 500);
    const segment = source.slice(lookbackStart, typeIndex);
    const keyMatches = Array.from(segment.matchAll(/key\s*:\s*"([^"]+)"/g));
    if (keyMatches.length === 0) continue;
    const lastKey = keyMatches[keyMatches.length - 1];
    const keyStartInSegment = lastKey.index ?? 0;
    const keyText = lastKey[1];
    // 确保 key 与 type 之间没有对象闭合（防止跨对象匹配）
    const between = segment.slice(keyStartInSegment, segment.length);
    if (between.includes('}')) {
      continue;
    }
    keys.add(keyText);
  }
  return Array.from(keys);
}

/**
 * 从 schema.ts 文本中解析 dockMediaSlots 的 targetField
 */
function parseDockTargetsFromSchema(source) {
  const targets = new Set();
  const slotsBlock = /dockMediaSlots\s*:\s*\[([\s\S]*?)\]/g;
  const targetFieldPattern = /targetField\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = slotsBlock.exec(source))) {
    const block = m[1];
    let tm;
    while ((tm = targetFieldPattern.exec(block))) {
      targets.add(tm[1]);
    }
  }
  return Array.from(targets);
}

/**
 * 从 config.ts 文本中解析 DockSlots 的 targetField
 */
function parseDockTargetsFromConfig(source) {
  const targets = new Set();
  const slotsArray = /:\s*PromptDockMediaSlotDescriptor\[\]\s*=\s*\[([\s\S]*?)\];/g;
  const targetFieldPattern = /targetField\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = slotsArray.exec(source))) {
    const block = m[1];
    let tm;
    while ((tm = targetFieldPattern.exec(block))) {
      targets.add(tm[1]);
    }
  }
  return Array.from(targets);
}

/**
 * 从 schema.ts 校验 prompt.dockMode 是否允许抑制（不为 twoWay）
 */
function checkDockMode(source) {
  const m = /prompt\s*:\s*\{[\s\S]*?dockMode\s*:\s*"([^"]+)"/m.exec(source);
  if (!m) return { defined: false, ok: true, mode: undefined };
  const mode = m[1];
  return { defined: true, ok: mode !== 'twoWay', mode };
}

async function main() {
  const files = await listFiles(modelsDir);
  const schemaFiles = files.filter((f) => /schema\.ts$/.test(f));
  const configFiles = files.filter((f) => /config\.ts$/.test(f));

  const configByModel = new Map();
  for (const file of configFiles) {
    const text = await fs.readFile(file, 'utf8');
    const targets = parseDockTargetsFromConfig(text);
    const model = basename(join(file, '..'));
    configByModel.set(model, { file, targets });
  }

  const problems = [];

  for (const schemaFile of schemaFiles) {
    const model = basename(join(schemaFile, '..'));
    const schemaText = await fs.readFile(schemaFile, 'utf8');
    const uploadKeys = parseUploadFieldKeysFromSchema(schemaText);
    if (uploadKeys.length === 0) {
      continue; // 无上传字段，跳过
    }
    const schemaDockTargets = parseDockTargetsFromSchema(schemaText);
    const config = configByModel.get(model);
    const configTargets = config ? config.targets : [];
    const allTargets = new Set([...(schemaDockTargets || []), ...(configTargets || [])]);
    const missing = uploadKeys.filter((k) => !allTargets.has(k));
    const dockModeInfo = checkDockMode(schemaText);

    if (missing.length > 0 || !dockModeInfo.ok) {
      problems.push({
        model,
        schemaFile,
        configFile: config?.file,
        uploadKeys,
        schemaDockTargets,
        configTargets,
        missing,
        dockMode: dockModeInfo.mode,
        dockModeDefined: dockModeInfo.defined,
      });
    }
  }

  if (problems.length > 0) {
    console.error('Dock 媒体映射校验失败：');
    for (const p of problems) {
      console.error(`- 模型 ${p.model}`);
      console.error(`  schema: ${p.schemaFile}`);
      if (p.configFile) console.error(`  config: ${p.configFile}`);
      console.error(`  上传字段: ${p.uploadKeys.join(', ')}`);
      console.error(`  Schema 声明槽: ${(p.schemaDockTargets || []).join(', ') || '无'}`);
      console.error(`  Config 声明槽: ${(p.configTargets || []).join(', ') || '无'}`);
      console.error(`  缺失映射: ${p.missing.join(', ') || '无'}`);
      if (p.dockModeDefined) {
        console.error(`  prompt.dockMode: ${p.dockMode}`);
      } else {
        console.error('  prompt.dockMode: 未声明');
      }
    }
    process.exit(1);
  } else {
    console.log('Dock 媒体映射校验通过。');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
