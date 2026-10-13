import { describe, expect, it } from 'vitest';
import { validateImportPayload } from '../validation';

/**
 * 验证 sanitize 边界对未知类型节点与旧 note 节点的降级行为：
 * 降级为自由注释（保留文本），bundle 导入不失败，
 * bundle 插入链路看到 annotations 输出。
 */

const wrapAsBundle = (nodeGraph: Record<string, unknown>): unknown => ({
  version: 3,
  exportedAt: '2026-07-28T00:00:00.000Z',
  nodeGraph,
});

describe('validateImportPayload - sanitize 降级为注释', () => {
  it('未知类型节点降级为自由注释，文本保留', () => {
    const raw = wrapAsBundle({
      id: 'g1',
      name: '降级测试',
      nodes: [
        {
          id: 'mystery-1',
          type: 'some-future-type',
          position: { x: 100, y: 100 },
          data: { content: '神秘内容', label: '可读标签' },
        },
      ],
      annotations: [],
    });

    const result = validateImportPayload(raw, { modelInlineControlsCollapsedDefault: false });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.nodeGraph).toBeDefined();
    expect(result.nodeGraph?.nodes).toHaveLength(0);
    // 降级产出的注释与显式 annotations 合并
    const downgraded = (result.nodeGraph?.annotations ?? []).find(
      (ann) => ann.content === '神秘内容' || ann.content === '可读标签',
    );
    expect(downgraded).toBeDefined();
    expect(downgraded?.binding).toEqual({ type: 'free' });
    expect(downgraded?.position).toEqual({ x: 100, y: 100 });
    // 至少有一条 warning 说明发生了降级
    expect(result.warnings.some((w) => w.includes('已改为自由注释'))).toBe(true);
  });

  it('旧 note 节点降级为自由注释（保留 content）', () => {
    const raw = wrapAsBundle({
      id: 'g1',
      name: '旧 note 降级',
      nodes: [
        {
          id: 'old-note',
          type: 'note',
          position: { x: 50, y: 60 },
          data: { content: '旧 note 文本', color: '#ff0000' },
        },
      ],
      annotations: [],
    });

    const result = validateImportPayload(raw, { modelInlineControlsCollapsedDefault: false });

    expect(result.valid).toBe(true);
    expect(result.nodeGraph?.nodes).toHaveLength(0);
    const ann = (result.nodeGraph?.annotations ?? []).find((a) => a.content === '旧 note 文本');
    expect(ann).toBeDefined();
    expect(ann?.binding).toEqual({ type: 'free' });
    expect(ann?.position).toEqual({ x: 50, y: 60 });
  });
});
