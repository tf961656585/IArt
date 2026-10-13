import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import type { ProjectRecord } from "@iart/contracts";

import {
  ensureProjectFolderDirs,
  ensureStorageDirs,
  getProjectFolderPaths,
  getRecentProjects,
  isValidProjectFolder,
} from "../storage.cts";
import { normalizeNodeGraph } from "../project-graph.cts";
import { buildProjectDocument } from "../project-document.cts";
import * as projectStorage from "../project-storage.cts";
import {
  type CompatFailureDiagnosticsMap,
  type FieldRecord,
  type LoadedProject,
  type NodeWithRuntimeLayout,
  type ProjectDocumentLike,
  type ProjectDocumentProjectionLike,
  type ProjectRecordWithAuthority,
  type RecentProjectItem,
  type RecentProjectsIndex,
  type RecentProjectsPayload,
  getNumericValueOrZero,
  getStringField,
  isRecord,
  normalizeProjectMediaAssetsOrEmpty,
  normalizeString,
  toNodeGraphLike,
  toProjectDocumentLike,
  toPendingStateLike,
} from "./common.cts";

export const buildProjectNodeStateAuthority = (
  projectFolderPath: unknown,
  options: { nodeGraphId: unknown | undefined; pendingState: unknown | undefined } = { nodeGraphId: undefined, pendingState: undefined },
) => {
  const pendingState = toPendingStateLike(
    options.pendingState ??
      projectStorage.getPendingProjectDeltaState(projectFolderPath),
  );
  const mergedDelta = isRecord(pendingState.mergedDelta)
    ? pendingState.mergedDelta
    : null;
  const nodeGraphId =
    normalizeString(options.nodeGraphId) ||
    normalizeString(((): unknown | undefined => { const g = toNodeGraphLike(mergedDelta); return (g !== null && g !== undefined ? g.id : undefined); })()) ||
    null;
  const hasPendingWrite = Boolean(pendingState.hasPendingWrite);
  return {
    owner: "backend",
    nodeGraphId,
    formalState: hasPendingWrite
      ? "backend_pending_write"
      : "backend_persisted",
    hasPendingWrite,
    canResumePendingChanges: Boolean(pendingState.canResumePendingChanges),
    pendingChangeCount: getNumericValueOrZero(pendingState.pendingChangeCount),
  };
};
export const resolveProjectDocumentAuthoritySnapshot = (
  projectFolderPath: unknown,
  projectDocument: unknown,
  nodeGraphId: unknown | undefined,
) => {
  const projectDocumentRecord = toProjectDocumentLike(projectDocument);
  const rawBaseDocument: unknown = buildProjectDocument(
    (projectDocumentRecord !== null && projectDocumentRecord !== undefined ? projectDocumentRecord.nodeGraph : undefined) ?? projectDocument,
    isRecord((projectDocumentRecord !== null && projectDocumentRecord !== undefined ? projectDocumentRecord.mediaAssets : undefined))
      ? (projectDocumentRecord as ProjectDocumentLike).mediaAssets
      : {},
  );
  const baseDocumentRecord = toProjectDocumentLike(rawBaseDocument);
  if (!(baseDocumentRecord !== null && baseDocumentRecord !== undefined ? baseDocumentRecord.nodeGraph : undefined)) {
    return {
      projectDocument: { nodeGraph: null, mediaAssets: {} },
      nodeStateAuthority: buildProjectNodeStateAuthority(projectFolderPath, {
        nodeGraphId: normalizeString(nodeGraphId) || null,
        pendingState: undefined,
      }),
    };
  }
  const baseDocument = {
    nodeGraph: (baseDocumentRecord as ProjectDocumentLike).nodeGraph,
    mediaAssets: normalizeProjectMediaAssetsOrEmpty(
      (baseDocumentRecord as ProjectDocumentLike).mediaAssets,
    ),
  };
  const pendingState = toPendingStateLike(
    projectStorage.getPendingProjectDeltaState(projectFolderPath),
  );
  const projection: unknown =
    projectStorage.projectPendingProjectDocumentProjection(
      projectFolderPath,
      baseDocument,
    );
  const projectionRecord = isRecord(projection)
    ? (projection as ProjectDocumentProjectionLike)
    : null;
  const projectedDocument = toProjectDocumentLike(
    (projectionRecord !== null && projectionRecord !== undefined ? projectionRecord.projectDocument : undefined),
  );
  const projectedNodeGraph = (projectedDocument !== null && projectedDocument !== undefined ? projectedDocument.nodeGraph : undefined);
  const effectiveNodeGraph = projectedNodeGraph ?? baseDocument.nodeGraph;
  const effectiveNodeGraphRecord = toNodeGraphLike(effectiveNodeGraph);
  const baseNodeGraphRecord = toNodeGraphLike(baseDocument.nodeGraph);
  const effectiveProjectDocument = {
    ...baseDocument,
    nodeGraph: effectiveNodeGraph,
    mediaAssets: baseDocument.mediaAssets,
  };
  const authority = buildProjectNodeStateAuthority(projectFolderPath, {
    nodeGraphId:
      normalizeString(nodeGraphId) ||
      normalizeString((effectiveNodeGraphRecord !== null && effectiveNodeGraphRecord !== undefined ? effectiveNodeGraphRecord.id : undefined)) ||
      normalizeString((baseNodeGraphRecord !== null && baseNodeGraphRecord !== undefined ? baseNodeGraphRecord.id : undefined)) ||
      null,
    pendingState: {
      ...pendingState,
      canResumePendingChanges: Boolean(
        (projectionRecord !== null && projectionRecord !== undefined ? projectionRecord.canResumePendingChanges : undefined),
      ),
      pendingChangeCount:
        typeof (projectionRecord !== null && projectionRecord !== undefined ? projectionRecord.pendingChangeCount : undefined) === "number" &&
        Number.isFinite((projectionRecord as ProjectDocumentProjectionLike).pendingChangeCount)
          ? (projectionRecord as ProjectDocumentProjectionLike).pendingChangeCount
          : pendingState.pendingChangeCount,
    },
  });
  return {
    projectDocument: effectiveProjectDocument,
    nodeStateAuthority: authority,
  };
};
export const loadProject = (
  projectFolderPath: unknown,
): LoadedProject | null => {
  const normalizedProjectFolderPath = normalizeString(projectFolderPath);
  if (!isValidProjectFolder(normalizedProjectFolderPath)) return null;
  try {
    ensureProjectFolderDirs(normalizedProjectFolderPath);
  } catch {
    void 0;
  }
  let projectDocument: unknown = projectStorage.loadProjectDocument(
    normalizedProjectFolderPath,
  );
  const projectDocumentRecord = toProjectDocumentLike(projectDocument);
  const nodeGraph = (projectDocumentRecord !== null && projectDocumentRecord !== undefined ? projectDocumentRecord.nodeGraph : undefined);
  if (!nodeGraph) return null;
  projectDocument = { ...(projectDocumentRecord ?? {}), nodeGraph };
  const authoritySnapshot = resolveProjectDocumentAuthoritySnapshot(
    normalizedProjectFolderPath,
    projectDocument,
    undefined,
  );
  return {
    nodeGraph: authoritySnapshot.projectDocument.nodeGraph,
    mediaAssets: isRecord(authoritySnapshot.projectDocument.mediaAssets)
      ? (authoritySnapshot.projectDocument
          .mediaAssets as ProjectRecord<unknown>["mediaAssets"])
      : {},
    nodeStateAuthority: authoritySnapshot.nodeStateAuthority,
    projectPath: normalizedProjectFolderPath,
  };
};
export const runLegacyCompatPreflight = (
  projectFolderPath: unknown,
):
  | { ok: true }
  | { ok: false; error: string; diagnostics: CompatFailureDiagnosticsMap | undefined } => {
  const normalizedProjectFolderPath = normalizeString(projectFolderPath);
  if (!isValidProjectFolder(normalizedProjectFolderPath)) {
    return {
      ok: false,
      error: "项目路径无效",
      diagnostics: { code: "invalid_project_path" },
    };
  }
  let projectDocument: unknown = projectStorage.loadProjectDocument(
    normalizedProjectFolderPath,
  );
  const projectDocumentRecord = toProjectDocumentLike(projectDocument);
  if (!(projectDocumentRecord !== null && projectDocumentRecord !== undefined ? projectDocumentRecord.nodeGraph : undefined)) {
    return {
      ok: false,
      error: "项目文档缺失",
      diagnostics: { code: "project_document_unavailable" },
    };
  }
  let nodeGraph = toNodeGraphLike((projectDocumentRecord as ProjectDocumentLike).nodeGraph);
  if (!nodeGraph) {
    return {
      ok: false,
      error: "项目文档缺失",
      diagnostics: { code: "project_document_unavailable" },
    };
  }
  let shouldRewriteRuntimeLayout = false;
  if (Array.isArray(nodeGraph.nodes)) {
    const nextNodes = nodeGraph.nodes.map((node) => {
      if (!isRecord(node)) return node;
      const runtimeNode = node as NodeWithRuntimeLayout;
      const hasRuntimeSize = Object.prototype.hasOwnProperty.call(
        runtimeNode,
        "size",
      );
      const hasMeasured = Object.prototype.hasOwnProperty.call(
        runtimeNode,
        "measuredSize",
      );
      const rawData = isRecord(runtimeNode.data) ? runtimeNode.data : null;
      const hasSizeMode = Boolean(
        rawData && Object.prototype.hasOwnProperty.call(rawData, "sizeMode"),
      );
      if (!hasRuntimeSize && !hasMeasured && !hasSizeMode) return node;
      shouldRewriteRuntimeLayout = true;
      const { size: _size, measuredSize: _measuredSize, ...rest } = runtimeNode;
      if (!rawData || !hasSizeMode) return rest;
      const { sizeMode: _sizeMode, ...restData } =
        rawData as FieldRecord<"sizeMode">;
      return { ...rest, data: restData };
    });
    if (shouldRewriteRuntimeLayout) {
      nodeGraph = { ...nodeGraph, nodes: nextNodes };
      projectDocument = { ...(projectDocumentRecord ?? {}), nodeGraph };
      const saved = projectStorage.saveProjectDocument(
        normalizedProjectFolderPath,
        {
          nodeGraph,
          mediaAssets: normalizeProjectMediaAssetsOrEmpty(
            (projectDocumentRecord as ProjectDocumentLike).mediaAssets,
          ),
        },
      );
      if (!saved) {
        return {
          ok: false,
          error: "旧项目运行时布局迁正失败",
          diagnostics: { code: "legacy_runtime_layout_rewrite_failed" },
        };
      }
    }
  }
  return { ok: true };
};
export const saveProject = (
  projectFolderPath: unknown,
  nodeGraph: unknown,
  mediaAssets: unknown,
  _options: { name: string | undefined } = { name: undefined },
) => {
  const normalizedProjectFolderPath = normalizeString(projectFolderPath);
  if (!isValidProjectFolder(normalizedProjectFolderPath)) return false;
  const normalizedGraph = toNodeGraphLike(normalizeNodeGraph(nodeGraph));
  if (!normalizedGraph) return false;
  const success = projectStorage.saveProjectDocument(
    normalizedProjectFolderPath,
    {
      nodeGraph: normalizedGraph,
      mediaAssets: normalizeProjectMediaAssetsOrEmpty(mediaAssets),
    },
  );
  if (!success) return false;
  return true;
};
export const listProjects = () => {
  const { index } = getRecentProjects();
  if (!isRecord(index) || !Array.isArray(index.recentProjects)) {
    return [];
  }
  return index.recentProjects.filter(isRecord).map((item) => {
    const recentProject = item as RecentProjectItem;
    const itemPath = normalizeString(recentProject.path);
    return {
      ...recentProject,
      path: itemPath,
      valid: isValidProjectFolder(itemPath),
    };
  });
};
export const estimateProjectSize = (projectFolderPath: unknown) => {
  const result = { totalSize: 0, mediaSize: 0, mediaCount: 0 };
  const normalizedProjectFolderPath = normalizeString(projectFolderPath);
  if (
    !normalizedProjectFolderPath ||
    !fs.existsSync(normalizedProjectFolderPath)
  )
    return result;
  const folderPaths = getProjectFolderPaths(normalizedProjectFolderPath);
  if (!folderPaths) return result;
  const calculateDirSize = (dirPath: string) => {
    let size = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isFile()) {
          try {
            size += fs.statSync(fullPath).size;
          } catch {
            void 0;
          }
        } else if (entry.isDirectory()) {
          size += calculateDirSize(fullPath);
        }
      }
    } catch {
      void 0;
    }
    return size;
  };
  result.totalSize = calculateDirSize(normalizedProjectFolderPath);
  if (fs.existsSync(folderPaths.media)) {
    try {
      const mediaEntries = fs.readdirSync(folderPaths.media, {
        withFileTypes: true,
      });
      for (const entry of mediaEntries) {
        if (entry.isFile()) {
          result.mediaCount++;
          try {
            result.mediaSize += fs.statSync(
              path.join(folderPaths.media, entry.name),
            ).size;
          } catch {
            void 0;
          }
        }
      }
    } catch {
      void 0;
    }
  }
  return result;
};
export const buildProjectRecord = (
  projectFolderPath: unknown,
): ProjectRecordWithAuthority | null => {
  const normalizedProjectFolderPath = normalizeString(projectFolderPath);
  const project = loadProject(normalizedProjectFolderPath);
  if (!project) return null;
  const nodeGraphRecord = toNodeGraphLike(project.nodeGraph);
  const nodeStateAuthority = isRecord(project.nodeStateAuthority)
    ? (project.nodeStateAuthority as FieldRecord<"canResumePendingChanges">)
    : null;
  return {
    name:
      getStringField(nodeGraphRecord, "name") ||
      path.basename(normalizedProjectFolderPath),
    nodeGraph: project.nodeGraph,
    mediaAssets: isRecord(project.mediaAssets)
      ? (project.mediaAssets as ProjectRecord<unknown>["mediaAssets"])
      : {},
    savedAt: 0,
    createdAt: 0,
    hasUnsavedChanges: Boolean((nodeStateAuthority !== null && nodeStateAuthority !== undefined ? nodeStateAuthority.canResumePendingChanges : undefined)),
    path: normalizedProjectFolderPath,
    nodeGraphId: getStringField(nodeGraphRecord, "id") || crypto.randomUUID(),
    nodeStateAuthority: project.nodeStateAuthority,
  };
};
export const buildProjectRecordFromSnapshot = (
  projectFolderPath: unknown,
  nodeGraph: unknown,
  mediaAssets: ProjectRecord<unknown>["mediaAssets"] = {},
): ProjectRecordWithAuthority | null => {
  const normalizedProjectFolderPath = normalizeString(projectFolderPath);
  const normalizedGraph = toNodeGraphLike(nodeGraph);
  if (!normalizedProjectFolderPath || !normalizedGraph) return null;
  const authoritySnapshot = resolveProjectDocumentAuthoritySnapshot(
    projectFolderPath,
    { nodeGraph: normalizedGraph, mediaAssets },
    normalizedGraph.id,
  );
  return {
    name:
      getStringField(normalizedGraph, "name") ||
      path.basename(normalizedProjectFolderPath),
    nodeGraph: authoritySnapshot.projectDocument.nodeGraph,
    mediaAssets: isRecord(authoritySnapshot.projectDocument.mediaAssets)
      ? (authoritySnapshot.projectDocument
          .mediaAssets as ProjectRecord<unknown>["mediaAssets"])
      : {},
    savedAt: 0,
    createdAt: 0,
    hasUnsavedChanges: Boolean(
      (authoritySnapshot.nodeStateAuthority !== null && authoritySnapshot.nodeStateAuthority !== undefined ? authoritySnapshot.nodeStateAuthority.canResumePendingChanges : undefined),
    ),
    path: normalizedProjectFolderPath,
    nodeGraphId: getStringField(normalizedGraph, "id") || crypto.randomUUID(),
    nodeStateAuthority: authoritySnapshot.nodeStateAuthority,
  };
};
export const readProjectNodeGraphSafely = (projectFolderPath: unknown) => {
  const normalizedProjectFolderPath = normalizeString(projectFolderPath);
  if (!normalizedProjectFolderPath) {
    return null;
  }
  try {
    const projectDocument = toProjectDocumentLike(
      projectStorage.loadProjectDocument(normalizedProjectFolderPath),
    );
    return (projectDocument !== null && projectDocument !== undefined ? projectDocument.nodeGraph : undefined) ?? null;
  } catch {
    return null;
  }
};
export const buildProjectIndexItem = (recentItem: unknown) => {
  if (!isRecord(recentItem)) return null;
  const recentProject = recentItem as RecentProjectItem;
  const recentPath = normalizeString(recentProject.path);
  if (!recentPath) return null;
  const nodeGraph = toNodeGraphLike(readProjectNodeGraphSafely(recentPath));
  return {
    nodeGraphId: getStringField(nodeGraph, "id"),
    name:
      getStringField(nodeGraph, "name") || normalizeString(recentProject.name),
    savedAt:
      typeof recentProject.lastOpenedAt === "number"
        ? recentProject.lastOpenedAt
        : undefined,
    createdAt:
      typeof recentProject.createdAt === "number"
        ? recentProject.createdAt
        : undefined,
    path: recentPath,
    valid: isValidProjectFolder(recentPath),
  };
};
export const getProjectIndex = () => {
  const paths = ensureStorageDirs();
  const recentProjectsPayload: unknown = getRecentProjects();
  const recentPayload = isRecord(recentProjectsPayload)
    ? (recentProjectsPayload as RecentProjectsPayload)
    : null;
  const recentIndex = isRecord((recentPayload !== null && recentPayload !== undefined ? recentPayload.index : undefined))
    ? ((recentPayload as RecentProjectsPayload).index as RecentProjectsIndex)
    : null;
  const recentProjects = Array.isArray((recentIndex !== null && recentIndex !== undefined ? recentIndex.recentProjects : undefined))
    ? (recentIndex as RecentProjectsIndex).recentProjects
    : [];
  const projects = (recentProjects as unknown[])
    .map((item: unknown) => buildProjectIndexItem(item))
    .filter(
      (item): item is NonNullable<ReturnType<typeof buildProjectIndexItem>> =>
        Boolean(item),
    );
  return {
    index: {
      version: 1,
      updatedAt: (() => {
        if (!isRecord(recentIndex)) return undefined;
        const value = recentIndex.updatedAt;
        return typeof value === "number" || typeof value === "string"
          ? value
          : undefined;
      })(),
      projects,
    },
    paths,
  };
};
