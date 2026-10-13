import { describe, expect, it } from 'vitest';
import { FIELD_ALIASES, resolveCanonicalFieldKey } from '../canonicalPorts';

describe('canonicalPorts', () => {
  it('规范名直接解析为自身', () => {
    expect(resolveCanonicalFieldKey('images', undefined)).toBe('images');
    expect(resolveCanonicalFieldKey('prompt', undefined)).toBe('prompt');
    expect(resolveCanonicalFieldKey('video', undefined)).toBe('video');
    expect(resolveCanonicalFieldKey('audio', undefined)).toBe('audio');
    expect(resolveCanonicalFieldKey('referenceImage', undefined)).toBe('referenceImage');
    expect(resolveCanonicalFieldKey('negativePrompt', undefined)).toBe('negativePrompt');
  });

  it('显式 canonicalKey 优先于别名解析', () => {
    expect(resolveCanonicalFieldKey('anything', 'referenceImage')).toBe('referenceImage');
  });

  it('无效 fieldKey 返回 undefined', () => {
    expect(resolveCanonicalFieldKey('nonexistent', undefined)).toBeUndefined();
    expect(resolveCanonicalFieldKey(undefined, undefined)).toBeUndefined();
  });

  it('FIELD_ALIASES 中不存在自映射', () => {
    // 所有自映射已移除：fieldKey 本身是规范名时由 resolveCanonicalFieldKey 直接返回
    for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
      expect(alias).not.toBe(canonical);
    }
  });
});
