// Storage 层 IPC 导出
export {
  // 项目管理
  listProjects,
  getProject,
  saveProjectDelta,
  flushProject,
  createProject,
  openProject,
  deleteProject,

  // 当前项目路径管理
  getCurrentProjectPath,
  setCurrentProjectPath,

  // 项目打开状态管理（已简化为空壳）
  openProjectSession,
  reportProjectPresence,

  // 统计
  getCacheStatistics,
  getProjectMetaIndex,
  getNodeTypeUsageStats,
  getCurrentProjectNodeTypeUsageStats,
  trackNodeTypeUsage,
  trackCurrentProjectNodeTypeUsage,
  getProjectCharacterPins,
  getCurrentProjectCharacterPins,
  setProjectCharacterPinnedIds,
  setCurrentProjectCharacterPinnedIds,

  // 节点待恢复状态操作
  enqueuePendingNodeChanges,
  flushPendingNodeChanges,
  persistNodeChanges,
  persistProjectDelta,
  getPendingNodeChangesSnapshot,
  discardPendingNodeChanges,

  // 项目导出
  exportProjectBundle,
  getExportFilenameFromResponse,

  // 项目导入
  importProjectBundle,
  importBundleRuntimeAssets,

  // 运行域只读投影
  readAllRuntimeTasks,
  readRuntimeTaskOutputs,
  readRuntimeMediaAssetsByTask,

  // 节点输出清除
  clearNodeOutput,
  removeNodeOutputItem,

  // 后端可用性检测
  isLocalBackendPreferred,
} from './backend';

export type {
  PendingNodeChangesSnapshot,
  ProjectRecord,
  ProjectIndexItem,
  ProjectMetaIndex,
  CacheStatistics,
  CreateProjectResponse,
  OpenProjectResponse,
  CharacterPins,
} from './types';

export type { ProjectPresenceResult } from './backend';
