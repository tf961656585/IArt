import { useCallback, useState } from 'react';
import type { OpenEditorWindowResult, SelectFolderResult } from '@iart/backend-sdk';
import type { RevealProjectFolderResult } from '@iart/contracts';
import { useHubRuntime } from '../../components/providers/HubAppProvider';
import { useHubStore } from '../../client/store/hub-store';
import {
  createBlankNodeGraph,
  formatSelectFolderFailure,
  getElectronFilePath,
  getOpenEditorWindowFailureStatus,
  inferNameFromFile,
  safeFileName,
} from '../../client/projects/utils';

export interface CreateProjectPayload {
  name: string;
  dir: string;
}

function buildOpenSessionToken(): string {
  return 'desktop-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}

function formatRevealProjectFolderFailure(result: RevealProjectFolderResult | null | undefined): string {
  if (result && !result.ok && result.reason === 'path-missing') {
    return '项目目录已不在原来的位置，请检查它是否被移动或删除';
  }
  if (result && !result.ok && result.reason === 'not-absolute') {
    return '项目路径无效，请重新选择项目';
  }
  return '没能打开项目所在文件夹，请重试';
}

/**
 * projects 域 React 版操作 hook。逻辑与 vanilla 侧 createProjectsController
 * （controller-helpers/projects-controller-helper.ts + operations.ts）等价：
 * 状态写入 hub-store，过程提示写入本地 statusMessage（对应 vanilla 的 projectStatus）。
 */
export function useProjects() {
  const { projectsFeature, platform } = useHubRuntime();
  const projects = useHubStore((s) => s.projects);
  const setProjects = useHubStore((s) => s.setProjects);
  const setProjectsLoading = useHubStore((s) => s.setProjectsLoading);
  const setProjectsError = useHubStore((s) => s.setProjectsError);
  const [statusMessage, setStatusMessage] = useState('');
  const [exportingPath, setExportingPath] = useState<string | null>(null);

  const loadProjects = useCallback(async (): Promise<void> => {
    setProjectsLoading(true);
    setStatusMessage('');
    try {
      const data = await projectsFeature.loadProjects();
      setProjects(Array.isArray(data.projects) ? data.projects : []);
      setProjectsError(null);
    } catch (error: unknown) {
      console.error('[hub] loadProjects error:', error);
      setProjectsError('没能读取项目列表，请点击「刷新列表」重试');
    } finally {
      setProjectsLoading(false);
    }
  }, [projectsFeature, setProjects, setProjectsLoading, setProjectsError]);

  const openProject = useCallback(
    async (projectPath: string): Promise<boolean> => {
      const target: string = String(projectPath || '').trim();
      if (!target) {
        setStatusMessage('项目路径无效');
        return false;
      }

      try {
        if (!platform.isElectron()) {
          window.open('/', '_blank', 'noopener');
          setStatusMessage('项目已打开');
          return true;
        }

        const opened: OpenEditorWindowResult = await projectsFeature.openProject({
          projectPath: target,
          sessionToken: buildOpenSessionToken(),
        });

        if (!opened.ok) {
          console.error('[hub] openEditorWindow failed:', opened);
          setStatusMessage(getOpenEditorWindowFailureStatus(opened, '没能打开项目，请重试'));
          return false;
        }

        setStatusMessage('项目已打开');
        return true;
      } catch (error: unknown) {
        console.error('[hub] openProjectByPath error:', error);
        setStatusMessage('没能打开项目，请重试');
        return false;
      }
    },
    [platform, projectsFeature],
  );

  const createProject = useCallback(
    async (name: string, dir: string): Promise<void> => {
      const projectName: string = String(name || '').trim();
      const parentDir: string = String(dir || '').trim();
      if (!projectName) {
        setStatusMessage('请输入项目名称');
        return;
      }
      if (!parentDir) {
        setStatusMessage('请选择项目保存位置');
        return;
      }

      try {
        setStatusMessage('正在创建项目...');
        const createStartedAt: number = Date.now();
        console.info('[hub:create] start', { name: projectName, parentDir });

        const graph: Record<string, unknown> = createBlankNodeGraph(projectName);
        let data: Awaited<ReturnType<typeof projectsFeature.createProject>> | null = null;

        try {
          data = await projectsFeature.createProject({
            parentDir,
            nodeGraph: graph,
            name: projectName,
            mediaAssets: {},
          });
        } catch (error: unknown) {
          console.error('[hub] createProject error:', error);

          const errorPayload: Record<string, unknown> | null =
            error && typeof error === 'object' && 'payload' in error && error.payload && typeof error.payload === 'object'
              ? (error.payload as Record<string, unknown>)
              : null;
          const errorCode: string = errorPayload && typeof errorPayload['code'] === 'string' ? errorPayload['code'] : '';
          const createdProjectPath: string =
            errorPayload && typeof errorPayload['projectPath'] === 'string' ? errorPayload['projectPath'].trim() : '';

          if (errorCode === 'project_session_prepare_failed' && createdProjectPath) {
            setStatusMessage('项目已创建，正在刷新项目列表...');
            await loadProjects();
            setStatusMessage('项目已创建，但没能打开画布，请在项目列表中重新打开');
            return;
          }

          setStatusMessage('没能创建项目，请检查项目名称和保存位置后重试');
          return;
        }

        const projectPath: string = data && data.projectPath ? data.projectPath : '';
        console.info('[hub:create] created', { projectPath, elapsed: Date.now() - createStartedAt });

        if (!projectPath) {
          setStatusMessage('项目已创建，但没能打开画布，请在项目列表中重新打开');
          return;
        }

        setStatusMessage('项目已创建，正在刷新项目列表...');
        await loadProjects();
        setStatusMessage('项目已创建，正在打开画布...');

        try {
          const openStartedAt: number = Date.now();
          const opened: OpenEditorWindowResult = await projectsFeature.openProject({
            projectPath,
            sessionToken: buildOpenSessionToken(),
          });
          console.info('[hub:create] editor opened', { result: opened, elapsed: Date.now() - openStartedAt });

          if (opened.ok) {
            setStatusMessage('项目已创建，画布已打开');
          } else if (opened.code === 'invalid-project-folder') {
            setStatusMessage('项目已创建，但保存位置无效，请重新选择保存位置');
          } else {
            setStatusMessage(
              getOpenEditorWindowFailureStatus(opened, '项目已创建，但没能打开画布，请在项目列表中重新打开'),
            );
          }
        } catch (error: unknown) {
          console.error('[hub:create] editor open failed', { error, elapsed: Date.now() - createStartedAt });
          setStatusMessage('项目已创建，但没能打开画布，请在项目列表中重新打开');
        }
      } catch (error: unknown) {
        console.error('[hub] createProject error:', error);
        setStatusMessage('没能创建项目，请重试');
      }
    },
    [loadProjects, projectsFeature],
  );

  const deleteProject = useCallback(
    async (projectPath: string, projectName?: string): Promise<void> => {
      const target: string = String(projectPath || '').trim();
      if (!target) return;

      const confirmed: boolean = window.confirm(
        '确定从列表中移除项目「' + (projectName || '') + '」吗？\n\n' + '注意：只从列表中移除，项目文件仍保留在原来的位置。',
      );
      if (!confirmed) return;

      await projectsFeature.deleteProject(target);
      await loadProjects();
    },
    [loadProjects, projectsFeature],
  );

  const exportProject = useCallback(
    async (projectPath: string, projectName: string): Promise<void> => {
      const target: string = String(projectPath || '').trim();
      if (!target) return;

      if (exportingPath) {
        setStatusMessage('正在导出另一个项目，请稍候');
        return;
      }

      setExportingPath(target);
      const baseName: string = projectName || 'project';

      try {
        setStatusMessage('请选择导出文件的保存位置...');
        const destDirResult: SelectFolderResult = await platform.selectFolder({
          title: '选择导出文件保存位置',
          defaultPath: undefined,
          buttonLabel: '导出到此文件夹',
        });

        if (destDirResult && destDirResult.status === 'canceled') {
          setStatusMessage('已取消导出项目');
          return;
        }

        if (!(destDirResult && destDirResult.status === 'success' && destDirResult.path)) {
          setStatusMessage('没能选择保存位置，请重试');
          return;
        }

        const destPath: string = destDirResult.path + '/' + safeFileName(baseName) + '.iarts.zip';
        setStatusMessage('正在导出项目「' + baseName + '」...');
        await projectsFeature.exportBundle({ projectPath: target, destPath });
        setStatusMessage('项目「' + baseName + '」已导出到所选文件夹');
        // 导出完成后自动定位压缩包（spec 判据五历史特例：保留自动行为）。
        // 定位失败按 LFJ-011 给可见反馈，不静默吞掉。
        try {
          const revealed: RevealProjectFolderResult = await platform.revealProjectFolder(destPath);
          if (!(revealed && revealed.ok)) {
            console.error('[hub] exportProject reveal failed:', revealed);
            setStatusMessage('项目「' + baseName + '」已导出到所选文件夹，但没能打开文件所在位置');
          }
        } catch (error: unknown) {
          console.error('[hub] exportProject reveal error:', error);
          setStatusMessage('项目「' + baseName + '」已导出到所选文件夹，但没能打开文件所在位置');
        }
      } catch (error: unknown) {
        console.error('[hub] exportProject error:', error);
        setStatusMessage('没能导出项目，请重试');
      } finally {
        setExportingPath(null);
      }
    },
    [exportingPath, platform, projectsFeature],
  );

  const importProjectFile = useCallback(
    async (file: File | undefined): Promise<void> => {
      if (!file) return;

      if (!platform.isElectron()) {
        setStatusMessage('请在桌面应用中导入项目文件');
        return;
      }

      let destDir: string = '';
      setStatusMessage('请选择项目导入位置...');

      try {
        const result: SelectFolderResult = await platform.selectFolder({
          title: '选择项目导入位置',
          defaultPath: undefined,
          buttonLabel: '导入到此文件夹',
        });

        if (result && result.status === 'canceled') {
          setStatusMessage('已取消导入项目');
          return;
        }

        if (result && result.status === 'success' && result.path) {
          destDir = result.path;
        } else if (result && result.status === 'error') {
          console.error('[hub] importProjectFile selectFolder failed:', result.errorCode, result.debugMessage || '');
          setStatusMessage(formatSelectFolderFailure(result, '没能选择导入位置，请重试'));
          return;
        } else {
          setStatusMessage('没能选择导入位置，请重试');
          return;
        }
      } catch (error: unknown) {
        console.error('[hub] importProjectFile selectFolder error:', error);
        setStatusMessage('没能选择导入位置，请重试');
        return;
      }

      const bundlePath: string = getElectronFilePath(file);
      if (!bundlePath) {
        setStatusMessage('没能读取这个文件，请在桌面应用中导入');
        return;
      }

      setStatusMessage('正在导入项目...');

      try {
        const inferredName: string = inferNameFromFile(file);
        const data = await projectsFeature.importProjectBundle({
          bundlePath,
          destDir,
          name: inferredName || safeFileName(file.name || 'project'),
        });

        await loadProjects();
        const projectPath: string = data.projectPath;

        if (projectPath) {
          setStatusMessage('导入项目成功，正在打开项目...');
          const opened: boolean = await openProject(projectPath);
          if (opened) setStatusMessage('导入项目成功并已打开');
        }

        if (!projectPath) setStatusMessage('导入项目成功');
      } catch (error: unknown) {
        console.error('[hub] importProjectFile error:', error);
        setStatusMessage('没能导入项目，请重试');
      }
    },
    [loadProjects, openProject, platform, projectsFeature],
  );

  const importProjectFolder = useCallback(async (): Promise<void> => {
    if (!platform.isElectron()) {
      setStatusMessage('请在桌面应用中导入项目文件夹');
      return;
    }

    try {
      setStatusMessage('请选择要导入的项目文件夹...');
      const result: SelectFolderResult = await platform.selectProjectFolder({
        title: '选择要导入的项目文件夹',
        defaultPath: undefined,
        buttonLabel: '导入项目',
      });

      if (result && result.status === 'canceled') {
        setStatusMessage('已取消导入项目');
        return;
      }

      if (!(result && result.status === 'success' && result.path)) {
        if (result && result.status === 'error') {
          console.error('[hub] importProjectFolder selectProjectFolder failed:', result.errorCode, result.debugMessage || '');
          setStatusMessage(formatSelectFolderFailure(result, '没能选择项目文件夹，请重试'));
          return;
        }

        setStatusMessage('没能选择项目文件夹，请重试');
        return;
      }

      setStatusMessage('正在导入项目文件夹...');
      const data = await projectsFeature.importProjectFolder(result.path);
      await loadProjects();
      const projectPath: string = data.projectPath || result.path;

      if (projectPath) {
        setStatusMessage('导入项目文件夹成功，正在打开项目...');
        const opened: boolean = await openProject(projectPath);
        if (opened) setStatusMessage('导入项目文件夹成功并已打开');
      }

      if (!projectPath) setStatusMessage('导入项目文件夹成功');
    } catch (error: unknown) {
      console.error('[hub] importProjectFolder error:', error);
      setStatusMessage('没能导入项目文件夹，请重试');
    }
  }, [loadProjects, openProject, platform, projectsFeature]);

  const revealProjectFolder = useCallback(
    async (projectPath: string): Promise<boolean> => {
      const target: string = String(projectPath || '').trim();
      if (!target) {
        setStatusMessage('项目路径无效');
        return false;
      }

      setStatusMessage('正在打开项目所在文件夹...');

      try {
        if (!platform.isElectron()) {
          setStatusMessage('请在桌面应用中打开所在文件夹');
          return false;
        }

        const result = await projectsFeature.revealProjectFolder(target);
        if (result && typeof result === 'object' && result.ok) {
          setStatusMessage('已打开项目所在文件夹');
          return true;
        }

        setStatusMessage(formatRevealProjectFolderFailure(result));
        return false;
      } catch (error: unknown) {
        console.error('[hub] revealProjectFolder error:', error);
        setStatusMessage('没能打开项目所在文件夹，请重试');
        return false;
      }
    },
    [platform, projectsFeature],
  );

  return {
    projects,
    statusMessage,
    exportingPath,
    loadProjects,
    openProject,
    createProject,
    deleteProject,
    exportProject,
    importProjectFile,
    importProjectFolder,
    revealProjectFolder,
  };
}
