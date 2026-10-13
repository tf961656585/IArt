import type { NodeGraph, GraphNode } from '../types';
import type {
  ProjectMediaAssets,
  PendingNodeChangesSnapshot as SharedPendingNodeChangesSnapshot,
  ProjectRecord as SharedProjectRecord,
  ProjectIndexItem as SharedProjectIndexItem,
  ProjectMetaIndex as SharedProjectMetaIndex,
  CreateProjectRequest as SharedCreateProjectRequest,
  SaveProjectRequest as SharedSaveProjectRequest,
  NodeGraphPayload as SharedNodeGraphPayload,
  ProjectSaveDelta as SharedProjectSaveDelta,
  ProjectNodeStateSyncResult as SharedProjectNodeStateSyncResult,
  DeleteProjectRequest as SharedDeleteProjectRequest,
  StorageCreateProjectResult,
  StorageOpenProjectResult,
} from '@iart/contracts';

export type PendingNodeChangesSnapshot = SharedPendingNodeChangesSnapshot<NodeGraph>;

export type ProjectRecord = SharedProjectRecord<NodeGraph, ProjectMediaAssets>;

export type ProjectIndexItem = SharedProjectIndexItem;

export type ProjectMetaIndex = SharedProjectMetaIndex;

/** 缓存统计信息 */
export interface CacheStatistics {
  /** 项目总数 */
  projectCount: number;
  /** IndexedDB 总缓存大小（字节） */
  indexedDbSize: number;
  /** localStorage 总缓存大小（字节） */
  localStorageSize: number;
  /** 总缓存大小（字节） */
  totalSize: number;
  /** 各项目大小 */
  projectSizes: Array<{
    name: string;
    /** 总大小（NodeGraph 数据 + 媒体缓存） */
    size: number;
    /** 媒体缓存大小（字节） */
    mediaSize: number;
    /** 媒体文件数量 */
    mediaCount: number;
    /** 项目路径 */
    path: string;
  }>;
}

export type CreateProjectRequest = SharedCreateProjectRequest<NodeGraph, ProjectMediaAssets>;

export type CreateProjectResponse = StorageCreateProjectResult<NodeGraph, ProjectMediaAssets>;

export type OpenProjectResponse = StorageOpenProjectResult & {
  projectPath: string;
};

export type SaveProjectRequest = SharedSaveProjectRequest<NodeGraph>;

export type NodeGraphPayload = SharedNodeGraphPayload<NodeGraph>;

export type ProjectSaveDelta = SharedProjectSaveDelta<NodeGraphPayload, GraphNode>;

export type ProjectNodeStateSyncResult = SharedProjectNodeStateSyncResult;

export type DeleteProjectRequest = SharedDeleteProjectRequest;

export interface NodeTypeUsageEntry {
  count: number;
  lastUsedAt: number;
}

export interface NodeTypeUsageStats {
  version: number;
  updatedAt: number;
  byNodeKey: Record<string, NodeTypeUsageEntry>;
}

export interface CharacterPins {
  version: number;
  updatedAt: number;
  pinnedCharacterIds: string[];
}
