import type { ProjectMediaAssets, ProjectSaveDelta } from '@iart/contracts';
import * as loggingModule from './logging.cts';

type LoadedProjectDocument = {
  nodeGraph: unknown;
  mediaAssets: unknown | undefined;
};

type PendingProjectDeltaState = {
  hasPendingWrite: boolean;
  canResumePendingChanges: boolean;
  pendingChangeCount: number;
  mergedDelta: ProjectSaveDelta | null;
  processing: boolean;
  flushRequested: boolean;
};

type PendingNodeGraphProjection = {
  nodeGraph: unknown;
  canResumePendingChanges: boolean;
  pendingChangeCount: number;
};

type PendingProjectDocumentProjection = {
  projectDocument: LoadedProjectDocument;
  canResumePendingChanges: boolean;
  pendingChangeCount: number;
};

const buildUnavailablePendingState = (): PendingProjectDeltaState => ({
  hasPendingWrite: false,
  canResumePendingChanges: false,
  pendingChangeCount: 0,
  mergedDelta: null,
  processing: false,
  flushRequested: false,
});

const logProjectStorageUnavailable = (operation: string, projectPath: unknown) => {
  loggingModule.logDebug('[project-storage] desktop storage IPC adapter unavailable', {
    operation,
    projectPath: typeof projectPath === 'string' ? projectPath : null,
  });
};

const detectProjectStorage = (projectPath: unknown): null => {
  logProjectStorageUnavailable('detectProjectStorage', projectPath);
  return null;
};

const ensureProjectSqlite = (projectPath: unknown): unknown | null => {
  logProjectStorageUnavailable('ensureProjectSqlite', projectPath);
  return null;
};

const loadProjectDocument = (projectPath: unknown): LoadedProjectDocument | null => {
  logProjectStorageUnavailable('loadProjectDocument', projectPath);
  return null;
};

const loadProjectNodeGraph = (projectPath: unknown): unknown | null => {
  logProjectStorageUnavailable('loadProjectNodeGraph', projectPath);
  return null;
};

const saveProjectDocument = (projectPath: unknown, _projectDocument: LoadedProjectDocument): false => {
  logProjectStorageUnavailable('saveProjectDocument', projectPath);
  return false;
};

const saveProjectNodeGraph = (projectPath: unknown, _nodeGraph: unknown): false => {
  logProjectStorageUnavailable('saveProjectNodeGraph', projectPath);
  return false;
};

const saveProjectMediaAssetsPatch = (projectPath: unknown, _mediaAssetsPatch: ProjectMediaAssets): null => {
  logProjectStorageUnavailable('saveProjectMediaAssetsPatch', projectPath);
  return null;
};

const saveProjectDelta = (projectPath: unknown, _delta: unknown): null => {
  logProjectStorageUnavailable('saveProjectDelta', projectPath);
  return null;
};

const flushProject = async (projectPath: unknown): Promise<null> => {
  logProjectStorageUnavailable('flushProject', projectPath);
  return null;
};

const getPendingProjectDeltaState = (projectPath: unknown): PendingProjectDeltaState => {
  logProjectStorageUnavailable('getPendingProjectDeltaState', projectPath);
  return buildUnavailablePendingState();
};

const projectPendingNodeGraphProjection = (
  projectPath: unknown,
  nodeGraph: unknown,
): PendingNodeGraphProjection => {
  logProjectStorageUnavailable('projectPendingNodeGraphProjection', projectPath);
  return {
    nodeGraph,
    canResumePendingChanges: false,
    pendingChangeCount: 0,
  };
};

const projectPendingProjectDocumentProjection = (
  projectPath: unknown,
  projectDocument: LoadedProjectDocument,
): PendingProjectDocumentProjection => {
  logProjectStorageUnavailable('projectPendingProjectDocumentProjection', projectPath);
  return {
    projectDocument,
    canResumePendingChanges: false,
    pendingChangeCount: 0,
  };
};

const discardPendingProjectWrites = async (projectPath: unknown): Promise<null> => {
  logProjectStorageUnavailable('discardPendingProjectWrites', projectPath);
  return null;
};

const getProjectNodeCount = (projectPath: unknown): number => {
  logProjectStorageUnavailable('getProjectNodeCount', projectPath);
  return 0;
};

const getProjectEdgeCount = (projectPath: unknown): number => {
  logProjectStorageUnavailable('getProjectEdgeCount', projectPath);
  return 0;
};

export {
  detectProjectStorage,
  ensureProjectSqlite,
  loadProjectDocument,
  loadProjectNodeGraph,
  saveProjectDocument,
  saveProjectNodeGraph,
  saveProjectMediaAssetsPatch,
  saveProjectDelta,
  flushProject,
  getPendingProjectDeltaState,
  projectPendingProjectDocumentProjection,
  projectPendingNodeGraphProjection,
  discardPendingProjectWrites,
  getProjectNodeCount,
  getProjectEdgeCount,
};
