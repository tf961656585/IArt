import { describe, expect, it } from 'vitest';

import { mergeMediaAssets } from '../projectMediaAssetMerge';
import type { MediaAsset, MediaAssetThumbnailStatus, ProjectMediaAssets } from '@iart/contracts';

// 构造一个完整 MediaAsset 的工厂，便于在测试中只标注关心的字段。
const makeAsset = (overrides: {
  id: string;
  thumbnailStatus?: MediaAssetThumbnailStatus;
  thumbnailUrl?: string | null;
  originalUrl?: string;
  createdAt?: number;
  updatedAt?: number;
}): MediaAsset => ({
  id: overrides.id,
  mediaType: 'image',
  original: {
    url: overrides.originalUrl ?? `local-media://prj_x/${overrides.id}.png`,
    projectRef: 'prj_x',
    fileKey: `${overrides.id}.png`,
    sourceUrl: null,
    sourceFileName: null,
    mimeType: 'image/png',
    sizeBytes: 128,
    width: 640,
    height: 360,
    durationMs: null,
    fps: null,
  },
  thumbnail: {
    url: overrides.thumbnailUrl === undefined ? null : overrides.thumbnailUrl,
    mimeType: null,
    width: null,
    height: null,
    status: overrides.thumbnailStatus ?? 'missing',
    generatedAt: null,
    error: null,
  },
  lifecycle: {
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
  },
});

const emptyMap = (): ProjectMediaAssets => ({});

// 辅助：安全读取 ProjectMediaAssets 中的 asset（noUncheckedIndexedAccess 下值为 T | undefined）。
const getAsset = (map: ProjectMediaAssets, id: string): MediaAsset => {
  const asset = map[id];
  if (asset === undefined) {
    throw new Error(`expected asset "${id}" to exist in merged result`);
  }
  return asset;
};

describe('mergeMediaAssets', () => {
  // 场景 1: user-action 写 missing 不覆盖已有 ready（thumbnail 单调序保护）
  it('user-action 写 missing 不覆盖已有 ready（单调序保护）', () => {
    const prev: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'ready', thumbnailUrl: 'thumb-a.png', updatedAt: 100 }),
    };
    const patch: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'missing', updatedAt: 50 }),
    };
    const result = mergeMediaAssets(prev, patch, 'user-action');
    const a = getAsset(result, 'a');
    // thumbnail 被 existing 的 ready 保护
    expect(a.thumbnail.status).toBe('ready');
    expect(a.thumbnail.url).toBe('thumb-a.png');
  });

  // 场景 2: user-action 单调序边界——failed(3) 可覆盖 stale(2)，反向不可
  it('user-action 写 failed 可覆盖 stale，反向 stale 不覆盖 failed', () => {
    // failed(3) > stale(2)：可覆盖
    const prev1: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'stale', updatedAt: 100 }),
    };
    const patch1: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'failed', updatedAt: 50 }),
    };
    const result1 = mergeMediaAssets(prev1, patch1, 'user-action');
    expect(getAsset(result1, 'a').thumbnail.status).toBe('failed');

    // stale(2) < failed(3)：不可覆盖
    const prev2: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'failed', updatedAt: 100 }),
    };
    const patch2: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'stale', updatedAt: 50 }),
    };
    const result2 = mergeMediaAssets(prev2, patch2, 'user-action');
    expect(getAsset(result2, 'a').thumbnail.status).toBe('failed');
  });

  // 场景 3: backend-notification 写 ready 覆盖已有 missing（正常升级）
  it('backend-notification 写 ready 覆盖已有 missing（正常升级）', () => {
    const prev: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'missing', updatedAt: 100 }),
    };
    const patch: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'ready', thumbnailUrl: 'thumb-a.png', updatedAt: 50 }),
    };
    const result = mergeMediaAssets(prev, patch, 'backend-notification');
    const a = getAsset(result, 'a');
    expect(a.thumbnail.status).toBe('ready');
    expect(a.thumbnail.url).toBe('thumb-a.png');
  });

  // 场景 4: backend-notification 写 stale 覆盖已有 ready（backend 主动降级，无条件采纳）
  it('backend-notification 写 stale 覆盖已有 ready（无条件采纳）', () => {
    const prev: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'ready', thumbnailUrl: 'thumb-a.png', updatedAt: 100 }),
    };
    const patch: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'stale', thumbnailUrl: null, updatedAt: 50 }),
    };
    const result = mergeMediaAssets(prev, patch, 'backend-notification');
    const a = getAsset(result, 'a');
    // backend-notification 无条件采纳，即使 incoming.updatedAt 更小
    expect(a.thumbnail.status).toBe('stale');
    expect(a.thumbnail.url).toBeNull();
  });

  // 场景 5: backend-projection 写旧状态（updatedAt 较小）不覆盖已有新状态（updatedAt 保护）
  it('backend-projection 写旧状态不覆盖新状态（updatedAt 保护）', () => {
    const prev: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'ready', thumbnailUrl: 'thumb-a.png', updatedAt: 200 }),
    };
    const patch: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'missing', updatedAt: 100 }),
    };
    const result = mergeMediaAssets(prev, patch, 'backend-projection');
    const a = getAsset(result, 'a');
    // incoming.updatedAt(100) < existing.updatedAt(200)，不覆盖
    expect(a.thumbnail.status).toBe('ready');
    expect(a.thumbnail.url).toBe('thumb-a.png');
  });

  // 场景 6: backend-projection 写新状态（updatedAt 较大）覆盖已有旧状态
  it('backend-projection 写新状态覆盖旧状态', () => {
    const prev: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'missing', updatedAt: 100 }),
    };
    const patch: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'ready', thumbnailUrl: 'thumb-a.png', updatedAt: 200 }),
    };
    const result = mergeMediaAssets(prev, patch, 'backend-projection');
    const a = getAsset(result, 'a');
    expect(a.thumbnail.status).toBe('ready');
    expect(a.thumbnail.url).toBe('thumb-a.png');
  });

  // 场景 7: original.* last-write-wins by updatedAt（incoming 较新则覆盖，较旧则不覆盖）
  it('original.* last-write-wins by updatedAt', () => {
    // incoming 较新：覆盖
    const prev1: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', originalUrl: 'old.png', updatedAt: 100 }),
    };
    const patch1: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', originalUrl: 'new.png', updatedAt: 200 }),
    };
    const result1 = mergeMediaAssets(prev1, patch1, 'user-action');
    expect(getAsset(result1, 'a').original.url).toBe('new.png');

    // incoming 较旧：不覆盖
    const prev2: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', originalUrl: 'new.png', updatedAt: 200 }),
    };
    const patch2: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', originalUrl: 'old.png', updatedAt: 100 }),
    };
    const result2 = mergeMediaAssets(prev2, patch2, 'user-action');
    expect(getAsset(result2, 'a').original.url).toBe('new.png');
  });

  // 场景 8: updatedAt 缺失时——user-action thumbnail 按单调序（missing 不覆盖 ready）；original 取 incoming
  it('updatedAt 缺失时：user-action thumbnail 按单调序，original 取 incoming', () => {
    // 注：MediaAssetLifecycle.updatedAt 类型是 number（必填），但 merge 逻辑需防御运行时缺失
    // （跨边界 IPC 数据可能因后端 bug 缺失）。用 JSON.parse 构造真实运行时数据绕过 TS 类型。
    const prev = JSON.parse(JSON.stringify({
      a: makeAsset({ id: 'a', thumbnailStatus: 'ready', thumbnailUrl: 'thumb.png', originalUrl: 'old.png' }),
    })) as ProjectMediaAssets;
    const prevAsset = prev['a'];
    if (prevAsset !== undefined) {
      (prevAsset.lifecycle as { updatedAt: unknown }).updatedAt = undefined;
    }
    const patch = JSON.parse(JSON.stringify({
      a: makeAsset({ id: 'a', thumbnailStatus: 'missing', originalUrl: 'new.png' }),
    })) as ProjectMediaAssets;
    const patchAsset = patch['a'];
    if (patchAsset !== undefined) {
      (patchAsset.lifecycle as { updatedAt: unknown }).updatedAt = undefined;
    }

    const result = mergeMediaAssets(prev, patch, 'user-action');
    const a = getAsset(result, 'a');
    // thumbnail: 单调序保护，ready 不被 missing 降级
    expect(a.thumbnail.status).toBe('ready');
    // original: updatedAt 缺失，取 incoming（last-write-wins 默认）
    expect(a.original.url).toBe('new.png');
  });

  // 场景 9: project-load 全量替换（旧资产被清除）
  it('project-load 全量替换，清除 prev 中不在 patch 的资产', () => {
    const prev: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'ready', updatedAt: 100 }),
      b: makeAsset({ id: 'b', thumbnailStatus: 'ready', updatedAt: 100 }),
    };
    const patch: ProjectMediaAssets = {
      c: makeAsset({ id: 'c', thumbnailStatus: 'missing', updatedAt: 50 }),
    };
    const result = mergeMediaAssets(prev, patch, 'project-load');
    // 全量替换：a/b 被清除，只剩 c
    expect(Object.keys(result).sort()).toEqual(['c']);
    expect(getAsset(result, 'c').thumbnail.status).toBe('missing');
  });

  // 场景 10: patch 新增 prev 不存在的 id（直接采纳）
  it('patch 新增 prev 不存在的 id 直接采纳', () => {
    const prev: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'ready', updatedAt: 100 }),
    };
    const patch: ProjectMediaAssets = {
      b: makeAsset({ id: 'b', thumbnailStatus: 'missing', updatedAt: 50 }),
    };
    const result = mergeMediaAssets(prev, patch, 'user-action');
    // a 保留，b 新增
    expect(getAsset(result, 'a')).toBeDefined();
    expect(getAsset(result, 'b').thumbnail.status).toBe('missing');
  });

  // 场景 11: patch 不含但 prev 有的 id（保留）
  it('patch 不含但 prev 有的 id 保留', () => {
    const prev: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'ready', thumbnailUrl: 'thumb-a.png', updatedAt: 100 }),
      b: makeAsset({ id: 'b', thumbnailStatus: 'ready', thumbnailUrl: 'thumb-b.png', updatedAt: 100 }),
    };
    const patch: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', thumbnailStatus: 'ready', updatedAt: 200 }),
    };
    const result = mergeMediaAssets(prev, patch, 'backend-projection');
    // b 保留（patch 未含）
    const b = getAsset(result, 'b');
    expect(b.thumbnail.url).toBe('thumb-b.png');
  });

  // 补充场景：empty prev + empty patch 返回空对象
  it('empty prev + empty patch 返回空对象（project-load 除外）', () => {
    const result = mergeMediaAssets(emptyMap(), emptyMap(), 'user-action');
    expect(Object.keys(result)).toHaveLength(0);
  });

  // 补充场景：lifecycle.updatedAt 合并取 max
  it('lifecycle.updatedAt 合并取 max(prev, incoming)', () => {
    const prev: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', createdAt: 50, updatedAt: 300 }),
    };
    const patch: ProjectMediaAssets = {
      a: makeAsset({ id: 'a', createdAt: 50, updatedAt: 200 }),
    };
    const result = mergeMediaAssets(prev, patch, 'backend-notification');
    const a = getAsset(result, 'a');
    expect(a.lifecycle.updatedAt).toBe(300);
    // createdAt 保留 existing
    expect(a.lifecycle.createdAt).toBe(50);
  });
});
