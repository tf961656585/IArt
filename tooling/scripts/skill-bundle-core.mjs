// skill bundle 打包/校验共享模块。
//
// 纯校验与打包逻辑的共享模块，消费者：
//   - skill-catalog-build.mjs：本地产出 .skill-dist/（index.json + bundles/*.json，
//     对齐公开仓 skill-catalog 分支布局）
// （原另一消费者 skill-publish.mjs 为 R2 直传脚本，2026-10-13 随自建分发栈退役删除）
//
// 本模块不得引入任何分发通道语义（R2/wrangler/远端 URL），只承载：
// 文件收集、路径安全校验、bundle 组装、bundle/index 结构校验、sha512、index 合并。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 需要作为可执行文件安装的脚本后缀（chmod 0o755）。
export const EXECUTABLE_SUFFIXES = ['.sh'];

// bundle 内可接受的文件：排除系统隐藏文件与元数据。
export const isAcceptableFile = (file) => {
  const base = path.basename(file);
  if (base === '.DS_Store') return false;
  if (base.startsWith('.')) return false; // 其他隐藏文件
  return true;
};

// bundle 内文件路径安全校验：必须相对、不得含 .. 或绝对路径。
export const isSafeRelativePath = (relPath) => {
  if (path.isAbsolute(relPath)) return false;
  if (relPath.includes('..')) return false;
  if (relPath.startsWith('/')) return false;
  return true;
};

// 递归收集 skill 源目录下所有文件，返回相对路径列表（posix 分隔符）。
export const collectSkillFiles = (skillDir) => {
  const result = [];
  const walk = (dir, relBase) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        if (isAcceptableFile(entry.name)) {
          result.push({ fullPath, relPath });
        }
      }
    }
  };
  walk(skillDir, '');
  return result;
};

// 打包 skill 源目录为 bundle JSON 对象。
// 返回 { id, version, files: [{ path, content, executable }] }
export function buildSkillBundle(skillDir, skillMeta) {
  if (!skillMeta || typeof skillMeta !== 'object') {
    throw new Error('skill.json 元数据无效');
  }
  const { id, version } = skillMeta;
  if (typeof id !== 'string' || !id) throw new Error('skill.json 缺少 id');
  if (typeof version !== 'string' || !version) throw new Error('skill.json 缺少 version');

  const files = collectSkillFiles(skillDir);
  if (files.length === 0) {
    throw new Error(`skill 目录 ${skillDir} 无可打包文件`);
  }

  const bundleFiles = files.map(({ fullPath, relPath }) => {
    if (!isSafeRelativePath(relPath)) {
      throw new Error(`不安全的文件路径（拒绝绝对路径或 .. 穿越）: ${relPath}`);
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const executable = EXECUTABLE_SUFFIXES.some((suffix) => relPath.endsWith(suffix));
    return { path: relPath, content, executable };
  });

  return {
    id,
    version,
    files: bundleFiles,
  };
}

// bundle JSON 结构校验（独立于打包，用于测试与消费端复用）。
export function validateSkillBundle(bundle) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { ok: false, message: 'bundle 必须是 JSON 对象' };
  }
  if (typeof bundle.id !== 'string' || !bundle.id) {
    return { ok: false, message: 'bundle 缺少 id 字段（非空字符串）' };
  }
  if (typeof bundle.version !== 'string' || !bundle.version) {
    return { ok: false, message: 'bundle 缺少 version 字段（非空字符串）' };
  }
  if (!Array.isArray(bundle.files) || bundle.files.length === 0) {
    return { ok: false, message: 'bundle.files 必须是非空数组' };
  }
  for (const f of bundle.files) {
    if (typeof f.path !== 'string' || !f.path) {
      return { ok: false, message: 'bundle 内每个文件必须有 path 字段' };
    }
    if (!isSafeRelativePath(f.path)) {
      return { ok: false, message: `不安全的文件路径: ${f.path}` };
    }
    if (typeof f.content !== 'string') {
      return { ok: false, message: `bundle 文件 ${f.path} 的 content 必须是字符串` };
    }
    if (typeof f.executable !== 'boolean') {
      return { ok: false, message: `bundle 文件 ${f.path} 的 executable 必须是布尔值` };
    }
  }
  return { ok: true };
}

// skill.json 元数据校验。
export function validateSkillMeta(meta) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return { ok: false, message: 'skill.json 必须是 JSON 对象' };
  }
  const required = ['id', 'version', 'name', 'description'];
  for (const field of required) {
    if (typeof meta[field] !== 'string' || !meta[field]) {
      return { ok: false, message: `skill.json 缺少必填字段: ${field}` };
    }
  }
  return { ok: true };
}

// 计算 JSON 字符串的 sha512（hex）。bundle 发布后该值写入 index.json。
export const sha512Hex = (content) =>
  crypto.createHash('sha512').update(content, 'utf8').digest('hex');

// 构建 index.json 内容。existingIndex 为已发布的 index.json（可选）；
// 若存在则用新条目覆盖同 id 的旧条目，否则追加。
export function buildIndexJson(existingIndex, skillMeta, bundleKey, sha512) {
  const skills = Array.isArray(existingIndex?.skills) ? [...existingIndex.skills] : [];
  const idx = skills.findIndex((s) => s.id === skillMeta.id);
  const entry = {
    id: skillMeta.id,
    name: skillMeta.name,
    version: skillMeta.version,
    description: skillMeta.description,
    bundleKey,
    sha512,
  };
  if (idx >= 0) {
    skills[idx] = entry;
  } else {
    skills.push(entry);
  }
  return { version: 1, skills };
}
