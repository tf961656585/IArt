// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadHubSrcFile } from './hubTestUtils';

const SKILLS_HOOKS_SRC = 'src/features/skills/SkillsTab.hooks.ts';
const SKILLS_TAB_SRC = 'src/features/skills/SkillsTab.tsx';

describe('Hub Skill 商店页', () => {
  it('进入 skills tab 后拉取远端目录并渲染 skill 卡片', () => {
    const hooksSrc = loadHubSrcFile(SKILLS_HOOKS_SRC);

    /* 目录拉取走 fetchSkillCatalog，进入 tab 即激活（useSkills 内 loadSkills） */
    expect(hooksSrc).toContain('fetchSkillCatalog(controller.signal)');
    expect(hooksSrc).toContain('setCatalog(fetched)');

    const tabSrc = loadHubSrcFile(SKILLS_TAB_SRC);
    expect(tabSrc).toContain('void loadSkills();');
    expect(tabSrc).toContain('catalog.skills.map((skill) =>');
    expect(tabSrc).toContain('<SkillCard');
  });

  it('点击安装按钮触发 installSkill IPC，传入正确入参', () => {
    const hooksSrc = loadHubSrcFile(SKILLS_HOOKS_SRC);

    /* 安装请求构造：bundleUrl / sha512 / target / skillId 四元组走 platform.installSkill */
    expect(hooksSrc).toContain('buildBundleUrl(skill.bundleKey)');
    expect(hooksSrc).toContain('sha512: skill.sha512');
    expect(hooksSrc).toContain('target,');
    expect(hooksSrc).toContain('skillId: skill.id');
    expect(hooksSrc).toContain('await platform.installSkill(request);');

    /* 卡片安装按钮接线到 installSkill */
    const tabSrc = loadHubSrcFile(SKILLS_TAB_SRC);
    expect(tabSrc).toContain('onInstall={(s, target) => void installSkill(s, target)}');
  });

  it('本地版本低于远端时展示更新入口，点击全部更新触发 installSkill IPC', () => {
    const hooksSrc = loadHubSrcFile(SKILLS_HOOKS_SRC);

    /* 版本比较：远端高于本地 → update-available（驱动更新入口） */
    expect(hooksSrc).toContain("return { kind: 'update-available', installedVersion }");
    expect(hooksSrc).toContain('collectPendingUpdates(catalog, installedState, targetRows)');
    expect(hooksSrc).toContain('export function skillHasUpdate(');

    /* 全部更新：顺序遍历 pending 组合逐个 installSkill */
    expect(hooksSrc).toContain('const ok = await installSkill(item.skill, item.target);');
    expect(hooksSrc).toContain('`已更新 ${succeeded} 个，全部完成`');

    /* 更新入口按钮：计数与可见性由 pendingUpdates 驱动 */
    const tabSrc = loadHubSrcFile(SKILLS_TAB_SRC);
    expect(tabSrc).toContain('`全部更新（${pendingUpdates.length}）`');
    expect(tabSrc).toContain('void updateAll()');
  });
});
