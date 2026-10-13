// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadHubSrcFile } from './hubTestUtils';

const PROJECTS_HOOKS_SRC = 'src/features/projects/ProjectsTab.hooks.ts';
const PROJECTS_TAB_SRC = 'src/features/projects/ProjectsTab.tsx';

describe('Hub 项目入口去门禁', () => {
  it('项目访问不应再依赖登录或 API Key 前置校验', () => {
    const hooksSrc = loadHubSrcFile(PROJECTS_HOOKS_SRC);
    expect(hooksSrc).not.toContain('ensureCanEnterProject');
    expect(hooksSrc).not.toContain('const canEnterProject =');

    const tabSrc = loadHubSrcFile(PROJECTS_TAB_SRC);
    expect(tabSrc).not.toContain('ensureCanEnterProject');
    expect(tabSrc).not.toContain('disabled={!project.path}');
  });

  it('创建与导入按钮应保持可用，不再因未登录被禁用', () => {
    const tabSrc = loadHubSrcFile(PROJECTS_TAB_SRC);

    /* 创建/导入入口不绑定登录态 disabled */
    expect(tabSrc).not.toContain('disabled={!');
    expect(tabSrc).not.toContain('disabled');
  });

  it('未登录时不应出现项目入口被登录阻断的提示语义', () => {
    const tabSrc = loadHubSrcFile(PROJECTS_TAB_SRC);

    expect(tabSrc).not.toContain('未登录，无法进入项目');
    expect(tabSrc).not.toContain('当前操作需要先登录账号');
  });
});
