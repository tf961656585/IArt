import { describe, expect, it } from 'vitest';

import { compareSkillVersions } from '..';

describe('compareSkillVersions', () => {
  it('相等版本返回 0', () => {
    expect(compareSkillVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareSkillVersions('1.0', '1.0.0')).toBe(0);
  });

  it('远端更高时返回正数（b > a 方向）', () => {
    expect(compareSkillVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareSkillVersions('0.9.9', '1.0.0')).toBeLessThan(0);
    expect(compareSkillVersions('1.2.0', '1.10.0')).toBeLessThan(0);
  });

  it('本地更高（远端回退）时返回正数', () => {
    expect(compareSkillVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareSkillVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('非数字段按 0 处理', () => {
    expect(compareSkillVersions('1.0.x', '1.0.0')).toBe(0);
    expect(compareSkillVersions('1.0.1-beta', '1.0.0')).toBeGreaterThan(0);
  });
});
