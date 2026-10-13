/**
 * Stable Project ID Resolver
 *
 * 从 projectPath 解析/补写 stableProjectId（用于 local-media:// V2 URL）。
 *
 * 承载职责：
 * - 接收 projectPath
 * - 通过 storage service 打开对应项目的 sqlite db
 * - 读取 project_manifest.stableProjectId
 * - 失败时（db 打开失败、manifest 缺失）返回 null
 *
 * 该模块属于 storage 层能力，避免 storage 读写逻辑泄漏到 window 控制器层。
 *
 * 两个语义层级：
 * - resolveStableProjectId：只读，失败返回 null（供 bootstrap 构建等不可补写场景使用）
 * - ensureStableProjectId：读取或补写，旧项目首次打开时自动生成并持久化
 *   （供 coordinator registerScope 等可写场景使用）
 */

import { getDb, getDbForExistingProject } from './editor-storage-service.cjs';
import { readManifestFromDb } from './editor-storage-read-model.cjs';

const { generateStableProjectId } = require('@iart/utils/stable-project-id') as {
  generateStableProjectId: () => string;
};

export const resolveStableProjectId = (
  projectPath: string | null,
): string | null => {
  if (projectPath === null) return null;
  let db;
  try {
    db = getDbForExistingProject(projectPath);
  } catch (error) {
    console.error('[storage] resolveStableProjectId: open db failed', error);
    return null;
  }
  if (db === null) return null;
  const manifest = readManifestFromDb(db);
  if (manifest === null) return null;
  const stable = manifest.stableProjectId;
  if (typeof stable !== 'string' || stable.trim() === '') return null;
  return stable;
};

/**
 * 读取或补写 stableProjectId。
 *
 * 若 manifest 已有有效 stableProjectId，直接返回。
 * 若 manifest 存在但 stableProjectId 为空（旧项目），生成新值并 UPDATE 补写，保证幂等。
 * 若 manifest 不存在或 db 打开失败，返回 null（不强行创建 manifest，避免与 createProject 主链冲突）。
 *
 * 返回 stableProjectId（已持久化）或 null（无法写入）。
 */
export const ensureStableProjectId = (
  projectPath: string | null,
): string | null => {
  if (projectPath === null) return null;
  let db;
  try {
    db = getDb(projectPath);
  } catch (error) {
    console.error('[storage] ensureStableProjectId: open db failed', error);
    return null;
  }
  if (db === null) return null;
  const manifest = readManifestFromDb(db);
  if (manifest === null) {
    // manifest 不存在：项目尚未通过 createProject 初始化，不强行写入
    return null;
  }
  const existing = manifest.stableProjectId;
  if (typeof existing === 'string' && existing.trim() !== '') {
    return existing;
  }
  const generated = generateStableProjectId();
  try {
    db.prepare(
      'UPDATE project_manifest SET stableProjectId = ? WHERE id = 1',
    ).run(generated);
    console.log('[storage] ensureStableProjectId: backfilled', {
      projectPath: projectPath.slice(-60),
    });
    return generated;
  } catch (error) {
    console.error('[storage] ensureStableProjectId: write failed', error);
    return null;
  }
};
