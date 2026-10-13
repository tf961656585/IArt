// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadHubSrcFile } from './hubTestUtils';

const PROJECTS_HOOKS_SRC = 'src/features/projects/ProjectsTab.hooks.ts';

const loadCreateProjectBlock = (src: string): string => {
  const start = src.indexOf('const createProject = useCallback');
  expect(start).toBeGreaterThanOrEqual(0);
  return src.slice(start);
};

describe('Hub 创建并进入分支收口', () => {
  it('创建失败、刷新失败、打开失败应保留独立状态分支', () => {
    const src = loadHubSrcFile(PROJECTS_HOOKS_SRC);
    const createBlock = loadCreateProjectBlock(src);

    /* 创建失败：状态区与弹窗各自收口 */
    expect(createBlock).toContain("console.error('[hub] createProject error:', error);");
    expect(createBlock).toMatch(
      /console\.error\('\[hub\] createProject error:', error\);[\s\S]*setStatusMessage\('没能创建项目，请检查项目名称和保存位置后重试'\);/,
    );

    /* session 准备失败但项目已创建：按已创建路径收口 */
    expect(createBlock).toContain("errorCode === 'project_session_prepare_failed'");
    expect(createBlock).toContain('createdProjectPath');

    /* 打开 Editor 失败：opened.ok === false 与异常两条分支都收口 */
    expect(createBlock).toContain('getOpenEditorWindowFailureStatus(');
    expect(createBlock).toContain("console.error('[hub:create] editor open failed'");
    expect(createBlock).toMatch(
      /console\.error\('\[hub:create\] editor open failed'[\s\S]*setStatusMessage\('项目已创建，但没能打开画布，请在项目列表中重新打开'\);/,
    );

    /* 列表中直接打开项目的失败分支 */
    expect(src).toContain("console.error('[hub] openEditorWindow failed:', opened);");
    expect(src).toContain("setStatusMessage(getOpenEditorWindowFailureStatus(opened, '没能打开项目，请重试'));");
    expect(src).toContain("console.error('[hub] openProjectByPath error:', error);");
  });

  it('创建并进入应固定先刷新项目列表，再尝试打开 Editor', () => {
    const src = loadHubSrcFile(PROJECTS_HOOKS_SRC);
    const createBlock = loadCreateProjectBlock(src);

    const refreshIndex = createBlock.indexOf('await loadProjects();');
    const openEditorIndex = createBlock.indexOf('projectsFeature.openProject({');

    expect(refreshIndex).toBeGreaterThanOrEqual(0);
    expect(openEditorIndex).toBeGreaterThanOrEqual(0);
    expect(refreshIndex).toBeLessThan(openEditorIndex);
  });
});
