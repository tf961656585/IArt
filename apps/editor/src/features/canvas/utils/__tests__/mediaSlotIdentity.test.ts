import { describe, expect, it } from 'vitest';
import {
  buildResultAreaAutoPrefixes,
  buildMediaSlotId,
  buildResultAreaTargetKey,
  parseAutoResultAreaItemMeta,
} from '../mediaSlotIdentity';

describe('mediaSlotIdentity', () => {
  it('parseAutoResultAreaItemMeta 支持 __out_ 条目', () => {
    const parsed = parseAutoResultAreaItemMeta('item-1__out_2');
    expect(parsed).toEqual({
      baseItemId: 'item-1',
      kind: 'out',
      oneBasedIndex: 2,
    });
  });

  it('parseAutoResultAreaItemMeta 兼容历史自动条目格式', () => {
    expect(parseAutoResultAreaItemMeta('item-1__img_1')?.kind).toBe('img');
    expect(parseAutoResultAreaItemMeta('item-1__vid_1')?.kind).toBe('vid');
    expect(parseAutoResultAreaItemMeta('item-1__aud_1')?.kind).toBe('aud');
    expect(parseAutoResultAreaItemMeta('item-1__txt_1')?.kind).toBe('txt');
  });

  it('parseAutoResultAreaItemMeta 对非自动条目返回 null', () => {
    expect(parseAutoResultAreaItemMeta('item-1')).toBeNull();
    expect(parseAutoResultAreaItemMeta('')).toBeNull();
  });

  it('build helpers 产出统一规则', () => {
    expect(buildResultAreaTargetKey('resultArea-a', 'item-1')).toBe('result-area_resultArea-a_item-1');
    expect(buildMediaSlotId('item-1', 2)).toBe('item-1__out_2');
    expect(buildResultAreaAutoPrefixes('item-1')).toEqual([
      'item-1__img_',
      'item-1__vid_',
      'item-1__aud_',
      'item-1__txt_',
      'item-1__out_',
    ]);
  });
});
