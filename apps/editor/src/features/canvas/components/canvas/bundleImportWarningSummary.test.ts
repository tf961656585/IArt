import { describe, expect, it } from 'vitest';

import { summarizeImportWarnings } from './bundleImportWarningSummary';

/**
 * 导入警告聚合：同类警告只出现一次并带数量，避免逐条刷屏；
 * 不同类别保持出现顺序，空串不占行。
 */
describe('summarizeImportWarnings', () => {
  it('同类警告只保留一条并附出现次数', () => {
    expect(
      summarizeImportWarnings([
        '有素材没能从文件里带进来。',
        '有素材没能从文件里带进来。',
        '有素材没能从文件里带进来。',
      ]),
    ).toEqual(['有素材没能从文件里带进来。（共 3 处）']);
  });

  it('不同类别按首次出现顺序保留，单条不加数量', () => {
    expect(
      summarizeImportWarnings([
        '有节点用到的素材在文件里找不到。',
        '文件里的画布状态读不出来，已按空白画布处理。',
        '有节点用到的素材在文件里找不到。',
      ]),
    ).toEqual([
      '有节点用到的素材在文件里找不到。（共 2 处）',
      '文件里的画布状态读不出来，已按空白画布处理。',
    ]);
  });

  it('空串与空白不占行', () => {
    expect(summarizeImportWarnings(['', '   ', '有旧节点读不出来，已跳过。'])).toEqual([
      '有旧节点读不出来，已跳过。',
    ]);
  });

  it('无警告时返回空列表', () => {
    expect(summarizeImportWarnings([])).toEqual([]);
  });
});
