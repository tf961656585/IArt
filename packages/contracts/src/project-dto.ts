export type ProjectMediaType = 'image' | 'video' | 'audio';

import type { EditorPersistenceState } from './editor-storage-contract';

export interface MediaAssetOriginal {
  url: string;
  projectRef: string | null | undefined;
  fileKey: string | null | undefined;
  sourceUrl: string | null | undefined;
  /** 导入素材的原始文件名（用户导入时的文件名含扩展名）；生成/加工产物与旧库数据为 null（2026-10-07 素材检索底座）。 */
  sourceFileName: string | null | undefined;
  mimeType: string | null | undefined;
  sizeBytes: number | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
  durationMs: number | null | undefined;
  fps: number | null | undefined;
}

export type MediaAssetThumbnailStatus = 'missing' | 'generating' | 'ready' | 'stale' | 'failed';

export interface MediaAssetThumbnailError {
  code: string | null | undefined;
  message: string | null | undefined;
  failedAt: number | null | undefined;
}

export interface MediaAssetThumbnail {
  url: string | null;
  mimeType: string | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
  status: MediaAssetThumbnailStatus;
  generatedAt: number | null | undefined;
  error: MediaAssetThumbnailError | null | undefined;
}

export interface MediaAssetLifecycle {
  createdAt: number;
  updatedAt: number;
}

export interface MediaAsset {
  id: string;
  mediaType: ProjectMediaType;
  original: MediaAssetOriginal;
  thumbnail: MediaAssetThumbnail;
  lifecycle: MediaAssetLifecycle;
}

export type ProjectMediaAssets = Record<string, MediaAsset>;

export interface RuntimeRef {
  taskId: string | null | undefined;
  resultId: string | null | undefined;
  assetId: string | null | undefined;
}

export interface ProjectRecord<TNodeGraph = unknown, TMediaAssets = ProjectMediaAssets> {
  name: string;
  nodeGraph: TNodeGraph;
  mediaAssets: TMediaAssets;
  savedAt: number;
  hasUnsavedChanges: boolean;
  createdAt: number;
  path: string;
  nodeGraphId: string;
}

export interface ProjectIndexItem {
  nodeGraphId: string;
  name: string;
  savedAt: number;
  createdAt: number;
  path: string;
  valid: boolean | undefined;
  mediaSize: number | undefined;
  mediaCount: number | undefined;
}

export interface ProjectMetaIndex {
  key: 'index';
  projects: ProjectIndexItem[];
  openedProjectPaths: string[] | undefined;
}

export interface PendingNodeChangesSnapshot<TNodeGraph = unknown> {
  key: 'current';
  nodeGraph: TNodeGraph;
  savedAt: number;
  hasUnsavedChanges: boolean;
}

export interface CreateProjectRequest<TNodeGraph = unknown, TMediaAssets = ProjectMediaAssets> {
  parentDir: string;
  name: string | undefined;
  nodeGraph: TNodeGraph | undefined;
  mediaAssets: TMediaAssets | undefined;
}

export interface SaveProjectRequest<TNodeGraph = unknown> {
  path: string;
  nodeGraph: TNodeGraph;
  name: string | undefined;
}

export type NodeGraphPayload<TNodeGraph = unknown> = TNodeGraph extends {
  nodes: unknown;
}
  ? Omit<TNodeGraph, 'nodes'>
  : unknown;

export interface ProjectSaveDelta<
  TNodeGraphPayload = unknown,
  TGraphNode = unknown,
> {
  nodeGraphId: string;
  fullReplace: boolean | undefined;
  graph: TNodeGraphPayload | undefined;
  nodes: {
    upsert: TGraphNode[] | undefined;
    remove: string[] | undefined;
  } | undefined;
}

export interface ProjectNodeStateSyncResult {
  ok: boolean;
  persistenceState: EditorPersistenceState | undefined;
}

export interface DeleteProjectRequest {
  path: string;
  deleteFiles: boolean | undefined;
}
