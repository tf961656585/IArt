// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadHubSrcFile } from './hubTestUtils';

const PROJECTS_FEATURE_SRC = 'src/client/projects/index.ts';
const PROJECTS_HOOKS_SRC = 'src/features/projects/ProjectsTab.hooks.ts';

describe('Hub 首页项目列表加载', () => {
  it('项目列表应走 IPC storageListProjects，避免首屏被重统计拖死', () => {
    const featureSrc = loadHubSrcFile(PROJECTS_FEATURE_SRC);

    expect(featureSrc).toContain('return platform.storageListProjects();');
    /* HTTP fetch 时代的超时/中止口径已消亡 */
    expect(featureSrc).not.toContain('fetch(');
    expect(featureSrc).not.toContain('AbortController');
    expect(featureSrc).not.toContain('PROJECT_LIST_REQUEST_TIMEOUT_MS');

    const hooksSrc = loadHubSrcFile(PROJECTS_HOOKS_SRC);
    expect(hooksSrc).toContain('await projectsFeature.loadProjects();');
  });

  it('项目列表加载失败应具备收口兜底，避免无限 loading', () => {
    const hooksSrc = loadHubSrcFile(PROJECTS_HOOKS_SRC);

    expect(hooksSrc).toContain(
      "console.error('[hub] loadProjects error:', error);",
    );
    expect(hooksSrc).toContain('没能读取项目列表，请点击「刷新列表」重试');
    expect(hooksSrc).toContain(
      'setProjects(Array.isArray(data.projects) ? data.projects : []);',
    );
    expect(hooksSrc).toContain('setProjectsLoading(false);');

    /* HTTP 时代的超时/中止兜底已随 IPC 化消亡 */
    expect(hooksSrc).not.toContain('AbortController');
    expect(hooksSrc).not.toContain('PROJECT_LIST_REQUEST_TIMEOUT_MS');
    expect(hooksSrc).not.toContain('加载项目超时');
  });
});
