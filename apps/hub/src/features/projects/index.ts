import type { OpenEditorWindowRequest } from '@iart/backend-sdk';
import type { StorageCreateProjectParams, StorageImportBundleParams } from '@iart/contracts';
import type { HubPlatformBridge } from '../../client/types';

export { ProjectsTab } from './ProjectsTab';

export const createProjectsFeature = (platform: HubPlatformBridge) => ({
  loadProjects() {
    return platform.storageListProjects();
  },
  createProject(payload: StorageCreateProjectParams) {
    return platform.storageCreateProject(payload);
  },
  openProject(target: OpenEditorWindowRequest) {
    return platform.openEditorWindow(target);
  },
  revealProjectFolder(projectPath: string) {
    return platform.revealProjectFolder(projectPath);
  },
  deleteProject(projectPath: string) {
    return platform.storageDeleteProject({ projectPath });
  },
  importProjectFolder(projectPath: string) {
    return platform.storageImportFolder({ projectPath });
  },
  importProjectBundle(params: StorageImportBundleParams) {
    return platform.storageImportBundle(params);
  },
  exportBundle(params: { projectPath: string; destPath: string }) {
    return platform.storageExportBundle(params);
  },
});
