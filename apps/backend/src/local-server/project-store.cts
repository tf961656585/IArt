export { normalizeNodeGraph } from "./project-graph.cts";
export {
  buildEditorOpenTarget,
  prepareProjectSession,
  attachProjectSession,
  resolveProjectSessionAttach,
  openProjectSessionPresence,
  registerOpenProject,
  touchOpenProject,
  closeProjectSession,
  releaseOpenProject,
  getOpenedProjectPaths,
} from "./project-store/sessions.cts";
export {
  createProjectFolder,
  createProject,
  prepareProjectForEditor,
  createProjectAndPrepareEditor,
  initializeEmptyProject,
  importProjectFolder,
  deleteProject,
} from "./project-store/lifecycle.cts";
export {
  runLegacyCompatPreflight,
  loadProject,
  saveProject,
  listProjects,
  estimateProjectSize,
  buildProjectNodeStateAuthority,
  buildProjectRecord,
  buildProjectRecordFromSnapshot,
  buildProjectIndexItem,
  getProjectIndex,
} from "./project-store/records.cts";
