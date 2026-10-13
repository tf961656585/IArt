import crypto from 'node:crypto';

const PROJECT_REF_PREFIX = 'prj_';

const normalizeProjectPath = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const normalizeProjectRef = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

/**
 * 按 projectPath 计算 V1 projectRef（SHA-256 前 32 hex）。
 *
 * @deprecated 新代码应使用 stableProjectId（V2）作为项目标识。
 * projectRef 仅保留用于：
 * - 兼容历史已存储的 local-media://prj_/<fileKey> URL（协议处理器双格式支持）
 * - backend 影子表未同步时的 fallback
 * 新增项目标识场景必须使用 @iart/utils/stable-project-id 的 generateStableProjectId。
 */
const buildProjectRef = (projectPath: unknown) => {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) return null;
  const digest = crypto.createHash('sha256').update(normalized).digest('hex');
  return `${PROJECT_REF_PREFIX}${digest.slice(0, 32)}`;
};

const isProjectRef = (value: unknown) => {
  const normalized = normalizeProjectRef(value);
  return new RegExp(`^${PROJECT_REF_PREFIX}[a-f0-9]{32}$`).test(normalized);
};

export = {
  PROJECT_REF_PREFIX,
  buildProjectRef,
  isProjectRef,
  normalizeProjectRef,
};
