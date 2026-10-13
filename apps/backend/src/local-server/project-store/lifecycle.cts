import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import type { ProjectRecord } from "@iart/contracts";

import { PROJECT_FOLDER_EXT } from "../constants.cts";
import { normalizeNodeGraph } from "../project-graph.cts";
import {
  buildProjectDocument,
  normalizeProjectDocument,
} from "../project-document.cts";
import {
  ensureProjectFolderDirs,
  generateProjectFolderName,
  generateProjectFolderNameWithSuffix,
  isValidProjectFolder,
} from "../storage.cts";
import * as projectStorage from "../project-storage.cts";
import {
  type CompatFailureDiagnosticsMap,
  LEGACY_COMPAT_FAILED_CODE,
  isRecord,
  normalizeString,
  toNodeGraphLike,
  toProjectDocumentLike,
} from "./common.cts";
import {
  getProjectSession,
  prepareProjectSession,
  releaseOpenProject,
} from "./sessions.cts";
import {
  buildProjectRecord,
  buildProjectRecordFromSnapshot,
  runLegacyCompatPreflight,
} from "./records.cts";

export const createProjectFolder = (
  parentDir: unknown,
  projectName: unknown,
  options: { nodeGraphId: string | undefined } = { nodeGraphId: undefined },
) => {
  const normalizedParentDir = normalizeString(parentDir);
  if (!normalizedParentDir || !fs.existsSync(normalizedParentDir)) return null;
  if (typeof projectName !== "string" || !projectName.trim()) {
    return { error: "项目名称不能为空" };
  }
  const safeName = projectName.trim();
  let suffix = 1;
  let projectFolderPath = path.join(
    normalizedParentDir,
    generateProjectFolderName(safeName),
  );
  while (fs.existsSync(projectFolderPath) && suffix < 100) {
    suffix++;
    projectFolderPath = path.join(
      normalizedParentDir,
      generateProjectFolderNameWithSuffix(safeName, suffix),
    );
  }
  if (fs.existsSync(projectFolderPath)) {
    return { error: "无法创建项目，文件夹名称冲突过多" };
  }
  const folderPaths = ensureProjectFolderDirs(projectFolderPath);
  if (!folderPaths) return null;
  const nodeGraphId =
    typeof options.nodeGraphId === "string" && options.nodeGraphId.trim()
      ? options.nodeGraphId.trim()
      : crypto.randomUUID();
  return { projectPath: projectFolderPath, nodeGraphId };
};
export const createProject = (
  parentDir: unknown,
  projectName: unknown,
  nodeGraph: unknown,
  mediaAssets: ProjectRecord<unknown>["mediaAssets"] = {},
) => {
  const normalizedParentDir = normalizeString(parentDir);
  if (!normalizedParentDir || !fs.existsSync(normalizedParentDir)) return null;
  if (typeof projectName !== "string" || !projectName.trim()) {
    return { error: "项目名称不能为空" };
  }
  const safeName = projectName.trim();
  const normalizedGraph = toNodeGraphLike(normalizeNodeGraph(nodeGraph)) || {
    id: crypto.randomUUID(),
    name: safeName,
    nodes: [],
    settings: {},
  };
  const projectDocument = toProjectDocumentLike(
    buildProjectDocument(normalizedGraph, {}),
  );
  const projectNodeGraph = (projectDocument !== null && projectDocument !== undefined ? projectDocument.nodeGraph : undefined) ?? normalizedGraph;
  const created = createProjectFolder(normalizedParentDir, safeName, {
    nodeGraphId: normalizeString(normalizedGraph.id),
  });
  if (!created) return null;
  if (created.error) return created;
  const saved = projectStorage.saveProjectDocument(created.projectPath, {
    nodeGraph: projectNodeGraph,
    mediaAssets,
  });
  if (!saved) {
    return null;
  }
  return {
    projectPath: created.projectPath,
    nodeGraph: projectNodeGraph,
    mediaAssets: (() => {
      const normalizedProjectDocument = toProjectDocumentLike(
        normalizeProjectDocument({ nodeGraph: normalizedGraph, mediaAssets }),
      );
      const normalizedMediaAssets =
        normalizedProjectDocument !== null
          ? normalizedProjectDocument.mediaAssets
          : undefined;
      return isRecord(normalizedMediaAssets)
        ? (normalizedMediaAssets as ProjectRecord<unknown>["mediaAssets"])
        : {};
    })(),
  };
};
export const prepareProjectForEditor = (
  projectPath: unknown,
) => {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) {
    return { error: "项目路径不能为空" };
  }
  const compat = runLegacyCompatPreflight(normalizedProjectPath);
  if (!compat.ok) {
    const compatFailure = compat as {
      ok: false;
      error: string;
      diagnostics: CompatFailureDiagnosticsMap | undefined;
    };
    return {
      error: compatFailure.error || "旧项目兼容预检失败",
      errorCode: LEGACY_COMPAT_FAILED_CODE,
      errorStage: "legacy-compat-preflight",
      diagnostics: compatFailure.diagnostics || null,
      projectPath: normalizedProjectPath,
    };
  }
  const project = buildProjectRecord(normalizedProjectPath);
  if (!project) {
    return { error: "项目文件损坏或无法读取" };
  }
  const existingSession = getProjectSession(normalizedProjectPath);
  if (
    (existingSession !== null && existingSession !== undefined ? existingSession.state : undefined) === "attached" ||
    (existingSession !== null && existingSession !== undefined ? existingSession.state : undefined) === "opened"
  ) {
    return {
      error: "项目已在别的窗口附着",
      errorCode: "project_already_open",
      projectPath: normalizedProjectPath,
    };
  }
  const editorOpenTarget = prepareProjectSession(normalizedProjectPath, {
    preparedProject: project,
  });
  if (!editorOpenTarget) {
    return {
      error: "项目已存在，但 Editor 会话准备失败",
      errorCode: "project_session_prepare_failed",
      projectPath: normalizedProjectPath,
    };
  }
  return { projectPath: normalizedProjectPath, project, editorOpenTarget };
};
export const createProjectAndPrepareEditor = (
  parentDir: unknown,
  projectName: unknown,
  nodeGraph: unknown,
  mediaAssets: ProjectRecord<unknown>["mediaAssets"] = {},
) => {
  const created = createProject(parentDir, projectName, nodeGraph, mediaAssets);
  if (!created) {
    return created;
  }
  if ("error" in created && created.error) {
    return created;
  }
  const createdProject = created;
  if (
    !("projectPath" in createdProject) ||
    typeof createdProject.projectPath !== "string"
  ) {
    return null;
  }
  const project = buildProjectRecordFromSnapshot(
    createdProject.projectPath,
    createdProject.nodeGraph,
    createdProject.mediaAssets,
  );
  if (!project) {
    return {
      error: "项目已创建，但项目快照构建失败",
      errorCode: "project_session_prepare_failed",
      projectPath: createdProject.projectPath,
    };
  }
  const editorOpenTarget = prepareProjectSession(createdProject.projectPath, {
    preparedProject: project,
  });
  if (!editorOpenTarget) {
    return {
      error: "项目已创建，但 Editor 会话准备失败",
      errorCode: "project_session_prepare_failed",
      projectPath: createdProject.projectPath,
      project,
    };
  }
  return { ...createdProject, project, editorOpenTarget };
};
export const initializeEmptyProject = (
  projectFolderPath: unknown,
  options: { name: string | undefined; nodeGraphId: string | undefined } = { name: undefined, nodeGraphId: undefined },
) => {
  const normalizedProjectFolderPath = normalizeString(projectFolderPath);
  if (!normalizedProjectFolderPath) return null;
  try {
    ensureProjectFolderDirs(normalizedProjectFolderPath);
  } catch {
    void 0;
  }
  const safeName =
    typeof options.name === "string" && options.name.trim()
      ? options.name.trim()
      : path.basename(normalizedProjectFolderPath, PROJECT_FOLDER_EXT) ||
        "未命名项目";
  const nodeGraphId =
    typeof options.nodeGraphId === "string" && options.nodeGraphId.trim()
      ? options.nodeGraphId.trim()
      : crypto.randomUUID();
  const emptyGraph = {
    id: nodeGraphId,
    name: safeName,
    nodes: [],
    settings: {},
  };
  const saved = projectStorage.saveProjectDocument(
    normalizedProjectFolderPath,
    { nodeGraph: emptyGraph, mediaAssets: undefined },
  );
  if (!saved) return null;
  return { nodeGraphId, name: safeName };
};
export const importProjectFolder = (projectFolderPath: unknown) => {
  const projectPath =
    typeof projectFolderPath === "string" ? projectFolderPath.trim() : "";
  if (!projectPath) {
    return { error: "项目路径不能为空" };
  }
  if (!isValidProjectFolder(projectPath)) {
    return { error: "项目不存在或不是有效的项目文件夹" };
  }
  const project = buildProjectRecord(projectPath);
  if (!project) {
    return { error: "项目文件损坏或无法读取" };
  }
  return { projectPath, project };
};
export const deleteProject = (projectFolderPath: unknown) => {
  releaseOpenProject(projectFolderPath);
  return true;
};
