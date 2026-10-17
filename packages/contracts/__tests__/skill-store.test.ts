import { describe, expect, it } from 'vitest';
import {
  SKILL_CUSTOM_TARGET_ERROR_CODES,
  SKILL_INSTALL_TARGETS,
  SKILL_IPC_CHANNELS,
  CustomSkillInstallTargetSchema,
  SkillAddCustomTargetRequestSchema,
  SkillCustomTargetErrorCodeSchema,
  SkillCustomTargetMutationResultSchema,
  SkillInstallRequestSchema,
  SkillInstallTargetIdSchema,
  SkillInstalledStateEntrySchema,
  SkillListCustomTargetsResultSchema,
  SkillRemoveCustomTargetRequestSchema,
  SkillRemoveCustomTargetResultSchema,
  SkillRevealInstallFolderRequestSchema,
  SkillRevealInstallFolderResultSchema,
  SkillUpdateCustomTargetRequestSchema,
} from '../src/skill-store';

const VALID_TARGET_ID = 'my-tools';
const VALID_ENTRY = { id: 'custom-0a1b2c3d', name: '我的工具', skillsDir: '/home/u/my-skills' };

describe('SKILL_IPC_CHANNELS（自定义目标管理通道）', () => {
  it('新增四个通道名', () => {
    expect(SKILL_IPC_CHANNELS.LIST_CUSTOM_TARGETS).toBe('skills:list-custom-targets');
    expect(SKILL_IPC_CHANNELS.ADD_CUSTOM_TARGET).toBe('skills:add-custom-target');
    expect(SKILL_IPC_CHANNELS.UPDATE_CUSTOM_TARGET).toBe('skills:update-custom-target');
    expect(SKILL_IPC_CHANNELS.REMOVE_CUSTOM_TARGET).toBe('skills:remove-custom-target');
  });

  it('既有三通道名保持不变', () => {
    expect(SKILL_IPC_CHANNELS.GET_INSTALLED_STATE).toBe('skills:get-installed-state');
    expect(SKILL_IPC_CHANNELS.INSTALL).toBe('skills:install');
    expect(SKILL_IPC_CHANNELS.REVEAL_INSTALL_FOLDER).toBe('skills:reveal-install-folder');
  });
});

describe('SKILL_INSTALL_TARGETS（内置 id 清单保持硬编码）', () => {
  it('仍为 agents/claude 两值', () => {
    expect([...SKILL_INSTALL_TARGETS]).toEqual(['agents', 'claude']);
  });
});

describe('SkillInstallTargetIdSchema（target 语义放宽为 id 格式）', () => {
  it.each(['agents', 'claude', 'a', '0abc', 'my-tools', 'custom-0a1b2c3d', 'a-b-c-2'])(
    '接受合法 id：%s',
    (id) => {
      expect(SkillInstallTargetIdSchema.parse(id)).toBe(id);
    },
  );

  it.each([
    '', // 空串
    '-abc', // 连字符开头
    'ABC', // 大写
    'a b', // 空格
    'a_b', // 下划线
    'a.b', // 点号
    '中文id', // 非 ASCII
    'a'.repeat(65), // 超长（>64）
  ])('拒绝非法 id：%j', (id) => {
    expect(() => SkillInstallTargetIdSchema.parse(id)).toThrow();
  });
});

describe('SkillInstallRequestSchema（target 放宽）', () => {
  it('接受自定义目标 id', () => {
    const request = {
      bundleUrl: 'https://example.test/bundle.json',
      sha512: 'sha',
      target: VALID_TARGET_ID,
      skillId: 'gpt-image',
    };
    expect(SkillInstallRequestSchema.parse(request)).toEqual(request);
  });

  it('拒绝不合法的 target id', () => {
    expect(() =>
      SkillInstallRequestSchema.parse({
        bundleUrl: 'https://example.test/bundle.json',
        sha512: 'sha',
        target: 'Bad_Target',
        skillId: 'gpt-image',
      }),
    ).toThrow();
  });

  it('拒绝多余字段（strict）', () => {
    expect(() =>
      SkillInstallRequestSchema.parse({
        bundleUrl: 'https://example.test/bundle.json',
        sha512: 'sha',
        target: VALID_TARGET_ID,
        skillId: 'gpt-image',
        extra: 1,
      }),
    ).toThrow();
  });
});

describe('SkillInstalledStateEntrySchema（target 放宽）', () => {
  it('接受自定义目标 id 条目', () => {
    expect(SkillInstalledStateEntrySchema.parse({
      skillId: 'gpt-image',
      version: '1.0.0',
      target: VALID_TARGET_ID,
    })).toEqual({ skillId: 'gpt-image', version: '1.0.0', target: VALID_TARGET_ID });
  });

  it('拒绝不合法的 target id', () => {
    expect(() =>
      SkillInstalledStateEntrySchema.parse({ skillId: 'g', version: '1', target: '' }),
    ).toThrow();
  });
});

describe('SkillRevealInstallFolderRequestSchema（target 放宽）', () => {
  it('接受自定义目标 id', () => {
    expect(SkillRevealInstallFolderRequestSchema.parse({
      skillId: 'gpt-image',
      target: VALID_TARGET_ID,
    })).toEqual({ skillId: 'gpt-image', target: VALID_TARGET_ID });
  });

  it('拒绝不合法的 target id', () => {
    expect(() =>
      SkillRevealInstallFolderRequestSchema.parse({ skillId: 'gpt-image', target: 'A/B' }),
    ).toThrow();
  });
});

describe('SkillRevealInstallFolderResultSchema（reason 扩入 unknown-target）', () => {
  it.each(['invalid-request', 'unknown-target', 'path-missing', 'not-in-electron', 'invoke-failed'] as const)(
    '接受 reason=%s',
    (reason) => {
      expect(SkillRevealInstallFolderResultSchema.parse({ ok: false, reason })).toEqual({
        ok: false,
        reason,
      });
    },
  );

  it('拒绝未知 reason', () => {
    expect(() => SkillRevealInstallFolderResultSchema.parse({ ok: false, reason: 'whatever' })).toThrow();
  });
});

describe('CustomSkillInstallTargetSchema', () => {
  it('接受合法条目', () => {
    expect(CustomSkillInstallTargetSchema.parse(VALID_ENTRY)).toEqual(VALID_ENTRY);
  });

  it('拒绝不合法 id', () => {
    expect(() => CustomSkillInstallTargetSchema.parse({ ...VALID_ENTRY, id: 'Bad!' })).toThrow();
  });

  it('拒绝空 name', () => {
    expect(() => CustomSkillInstallTargetSchema.parse({ ...VALID_ENTRY, name: '' })).toThrow();
  });

  it('name 上限 50 字符', () => {
    expect(() =>
      CustomSkillInstallTargetSchema.parse({ ...VALID_ENTRY, name: 'x'.repeat(51) }),
    ).toThrow();
    expect(() =>
      CustomSkillInstallTargetSchema.parse({ ...VALID_ENTRY, name: 'x'.repeat(50) }),
    ).not.toThrow();
  });

  it('拒绝空 skillsDir', () => {
    expect(() => CustomSkillInstallTargetSchema.parse({ ...VALID_ENTRY, skillsDir: '' })).toThrow();
  });

  it('skillsDir 上限 1024 字符', () => {
    expect(() =>
      CustomSkillInstallTargetSchema.parse({ ...VALID_ENTRY, skillsDir: `/${'a'.repeat(1024)}` }),
    ).toThrow();
    expect(() =>
      CustomSkillInstallTargetSchema.parse({ ...VALID_ENTRY, skillsDir: `/${'a'.repeat(1023)}` }),
    ).not.toThrow();
  });

  it('拒绝多余字段（strict）', () => {
    expect(() => CustomSkillInstallTargetSchema.parse({ ...VALID_ENTRY, extra: 1 })).toThrow();
  });
});

describe('SkillCustomTargetErrorCodeSchema（错误码联合）', () => {
  it('覆盖八个错误码', () => {
    expect([...SKILL_CUSTOM_TARGET_ERROR_CODES]).toEqual([
      'invalid-request',
      'duplicate-dir',
      'nested-dir',
      'reserved-dir',
      'not-found',
      'unknown-target',
      'persist-failed',
      'invoke-failed',
    ]);
  });

  it.each(SKILL_CUSTOM_TARGET_ERROR_CODES)('接受错误码 %s', (code) => {
    expect(SkillCustomTargetErrorCodeSchema.parse(code)).toBe(code);
  });

  it('拒绝未知错误码', () => {
    expect(() => SkillCustomTargetErrorCodeSchema.parse('whatever')).toThrow();
  });
});

describe('管理通道请求 schema（strict）', () => {
  it('add：接受 { name, dir }，拒绝多余字段', () => {
    expect(SkillAddCustomTargetRequestSchema.parse({ name: 'n', dir: '/a/b' })).toEqual({
      name: 'n',
      dir: '/a/b',
    });
    expect(() => SkillAddCustomTargetRequestSchema.parse({ name: 'n', dir: '/a/b', extra: 1 })).toThrow();
  });

  it('update：接受 { id, name, skillsDir }（全量提交），拒绝多余字段', () => {
    expect(
      SkillUpdateCustomTargetRequestSchema.parse({
        id: VALID_TARGET_ID,
        name: 'n',
        skillsDir: '/home/u/my-skills',
      }),
    ).toEqual({ id: VALID_TARGET_ID, name: 'n', skillsDir: '/home/u/my-skills' });
    expect(() =>
      SkillUpdateCustomTargetRequestSchema.parse({
        id: VALID_TARGET_ID,
        name: 'n',
        skillsDir: '/home/u/my-skills',
        extra: 1,
      }),
    ).toThrow();
  });

  it('update：缺 skillsDir（局部更新）被拒绝', () => {
    expect(() => SkillUpdateCustomTargetRequestSchema.parse({ id: VALID_TARGET_ID, name: 'n' })).toThrow();
  });

  it('remove：接受 { id }，拒绝多余字段', () => {
    expect(SkillRemoveCustomTargetRequestSchema.parse({ id: VALID_TARGET_ID })).toEqual({
      id: VALID_TARGET_ID,
    });
    expect(() => SkillRemoveCustomTargetRequestSchema.parse({ id: VALID_TARGET_ID, extra: 1 })).toThrow();
  });
});

describe('管理通道结果 schema', () => {
  it('list：接受空与非空 targets', () => {
    expect(SkillListCustomTargetsResultSchema.parse({ targets: [] })).toEqual({ targets: [] });
    expect(SkillListCustomTargetsResultSchema.parse({ targets: [VALID_ENTRY] })).toEqual({
      targets: [VALID_ENTRY],
    });
  });

  it('mutation：接受成功与失败分支', () => {
    expect(SkillCustomTargetMutationResultSchema.parse({ ok: true, target: VALID_ENTRY })).toEqual({
      ok: true,
      target: VALID_ENTRY,
    });
    expect(SkillCustomTargetMutationResultSchema.parse({ ok: false, error: 'duplicate-dir' })).toEqual({
      ok: false,
      error: 'duplicate-dir',
    });
  });

  it('mutation：拒绝未知错误码与多余字段', () => {
    expect(() => SkillCustomTargetMutationResultSchema.parse({ ok: false, error: 'whatever' })).toThrow();
    expect(() => SkillCustomTargetMutationResultSchema.parse({ ok: true, target: VALID_ENTRY, extra: 1 })).toThrow();
  });

  it('remove：接受 { ok: true } 与失败分支，拒绝多余字段', () => {
    expect(SkillRemoveCustomTargetResultSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(SkillRemoveCustomTargetResultSchema.parse({ ok: false, error: 'not-found' })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(() => SkillRemoveCustomTargetResultSchema.parse({ ok: true, extra: 1 })).toThrow();
  });
});
