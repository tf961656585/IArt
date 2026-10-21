/**
 * 参考区用途域模型的单元测试。
 *
 * 钉住设计文档里几条**有取舍的**判据（它们都是实现时容易各写一套的分叉）：
 * - 默认落位三档：唯一候选直绑 / 有多张位绑多张位 / 全单张位落「未指定」；
 * - 换绑：目标单张位已被占用时，原占用者退回未指定，两张图都保留；
 * - 模型切换重判：原用途仍存在则保留；重判出的位已被占用则保持未指定；
 * - 阻断两类：必填位没人占、有图没指定用途。
 */
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import type { ExecutableCatalogMediaSlot } from '@iart/contracts';

import {
  candidateSlots,
  collectSlotProblems,
  defaultSlotId,
  reassignSlot,
  rejudgeReferencesForModel,
} from '../referenceSlotModel';
import type { PromptDockReference } from '../PromptDock.types';

/**
 * 测试用的目录条目替身。
 *
 * 用途域模型只读 `media_slots`，其余字段与它无关；用只含所需字段的窄类型构造，避免
 * `as unknown as` 双断言（仓库禁止）——被测函数签名收窄为 `{ media_slots?: ... }` 即可。
 */
type SlotFixture = { model_id: string; media_slots: ExecutableCatalogMediaSlot[] };

/** 可灵图生视频形态：首帧必填 + 尾帧可选，都是单张位。 */
const twoSingleSlots: SlotFixture = {
  model_id: 'kling-i2v-demo',
  media_slots: [
    { slotId: 'first_frame', fieldKey: 'firstFrameImage', required: true, maxFiles: 1, mediaKind: 'image', label: '首帧' },
    { slotId: 'last_frame', fieldKey: 'lastFrameImage', required: false, maxFiles: 1, mediaKind: 'image', label: '尾帧' },
  ],
};

/** 图像编辑形态：一个多张参考位。 */
const oneMultiSlot: SlotFixture = {
  model_id: 'image-multi-ref-demo',
  media_slots: [
    { slotId: 'reference_image', fieldKey: 'images', required: false, maxFiles: 8, mediaKind: 'image', label: '普通参考' },
  ],
};

/** 单张位 + 多张位并存。 */
const mixedSlots: SlotFixture = {
  model_id: 'mixed-demo',
  media_slots: [
    { slotId: 'first_frame', fieldKey: 'firstFrameImage', required: false, maxFiles: 1, mediaKind: 'image', label: '首帧' },
    { slotId: 'reference_image', fieldKey: 'images', required: false, maxFiles: 8, mediaKind: 'image', label: '普通参考' },
  ],
};

const makeRef = (id: string, slotId: string | null = null): PromptDockReference => ({
  refId: id,
  assetId: `asset_${id}`,
  mediaType: 'image',
  label: id,
  slotId,
});

describe('候选与默认落位', () => {
  it('候选只按 mediaKind 过滤，保持目录顺序', () => {
    expect(candidateSlots(twoSingleSlots, 'image').map((s) => s.slotId)).toEqual([
      'first_frame',
      'last_frame',
    ]);
    expect(candidateSlots(twoSingleSlots, 'video')).toEqual([]);
  });

  it('唯一候选 → 直接绑定该用途', () => {
    expect(defaultSlotId(oneMultiSlot, 'image')).toBe('reference_image');
  });

  it('多个候选且存在多张位 → 绑多张位', () => {
    expect(defaultSlotId(mixedSlots, 'image')).toBe('reference_image');
  });

  it('多个候选全是单张位 → 未指定（刻意不按第一位自动占用）', () => {
    expect(defaultSlotId(twoSingleSlots, 'image')).toBeNull();
  });
});

describe('换绑与占用', () => {
  it('改绑到已被占用的单张位：原占用者退回未指定，两张图都保留', () => {
    const refs = [makeRef('a', 'first_frame'), makeRef('b', null)];
    const next = reassignSlot(refs, 'b', 'first_frame', twoSingleSlots);
    expect(next).toHaveLength(2);
    expect(next.find((r) => r.refId === 'a')?.slotId).toBeNull();
    expect(next.find((r) => r.refId === 'b')?.slotId).toBe('first_frame');
  });

  it('改绑到未占用的单张位：只改自己', () => {
    const refs = [makeRef('a', 'first_frame'), makeRef('b', null)];
    const next = reassignSlot(refs, 'b', 'last_frame', twoSingleSlots);
    expect(next.find((r) => r.refId === 'a')?.slotId).toBe('first_frame');
    expect(next.find((r) => r.refId === 'b')?.slotId).toBe('last_frame');
  });
});

describe('模型切换重判', () => {
  it('新模型仍有同名素材位 → 原样保留', () => {
    const refs = [makeRef('a', 'first_frame')];
    expect(rejudgeReferencesForModel(refs, twoSingleSlots)[0]?.slotId).toBe('first_frame');
  });

  it('新模型没有该用途 → 按新模型默认落位重判', () => {
    const refs = [makeRef('a', 'first_frame')];
    expect(rejudgeReferencesForModel(refs, oneMultiSlot)[0]?.slotId).toBe('reference_image');
  });

  it('重判出的单张位已被占用 → 保持未指定（不抢位）', () => {
    const refs = [makeRef('a', 'first_frame'), makeRef('b', 'last_frame')];
    // 切到一个只有 first_frame 单张位的模型：a 保留，b 重判后撞上 a 占用 → 未指定
    const onlyFirst: SlotFixture = {
      model_id: 'only-first',
      media_slots: [
        { slotId: 'first_frame', fieldKey: 'firstFrameImage', required: true, maxFiles: 1, mediaKind: 'image', label: '首帧' },
      ],
    };
    const next = rejudgeReferencesForModel(refs, onlyFirst);
    expect(next.find((r) => r.refId === 'a')?.slotId).toBe('first_frame');
    expect(next.find((r) => r.refId === 'b')?.slotId).toBeNull();
  });
});

describe('阻断判据', () => {
  it('必填位没人占 → 一条 required-slot-empty', () => {
    const problems = collectSlotProblems([makeRef('a', 'last_frame')], twoSingleSlots);
    const required = problems.filter((p) => p.kind === 'required-slot-empty');
    assert.equal(required.length, 1);
    expect(required[0]).toMatchObject({ fieldKey: 'firstFrameImage', label: '首帧' });
  });

  it('有图但没指定用途 → 一条 unspecified-reference', () => {
    const problems = collectSlotProblems([makeRef('a', null)], twoSingleSlots);
    expect(problems.filter((p) => p.kind === 'unspecified-reference')).toHaveLength(1);
  });

  it('首帧已占用且无未指定引用 → 无阻断', () => {
    expect(collectSlotProblems([makeRef('a', 'first_frame')], twoSingleSlots)).toEqual([]);
  });

  it('无素材位模型（纯文生视频）→ 不产生任何阻断', () => {
    const noSlots: SlotFixture = { model_id: 't2v', media_slots: [] };
    expect(collectSlotProblems([makeRef('a', null)], noSlots)).toEqual([]);
  });
});
