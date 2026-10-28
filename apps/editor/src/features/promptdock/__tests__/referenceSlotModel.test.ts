/**
 * 参考区用途域模型的单元测试。
 *
 * 钉住设计文档里几条**有取舍的**判据（它们都是实现时容易各写一套的分叉）：
 * - 默认落位三档：唯一候选直绑 / 有多张位绑多张位 / 全单张位落「未指定」；
 * - 换绑：目标单张位已被占用时，原占用者退回未指定，两张图都保留；
 * - 模型切换重判：原用途仍存在则保留；重判出的位已被占用则保持未指定；
 * - 阻断三类：必填位没人占、有图没指定用途、某用途绑定条数超过声明张数。
 */
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import type { ExecutableCatalogMediaSlot } from '@iart/contracts';

import {
  candidateSlots,
  collectSlotProblems,
  defaultSlotId,
  legacySlotId,
  reassignSlot,
  rejudgeReferencesForModel,
  resolveAddPlacement,
  resolveMediaSupport,
  slotBindingCount,
  slotHasRoom,
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

/** 用户实测形态：只勾选参考图，最多 2 张（`media_max_files` 覆盖后的投影）。 */
const cappedMultiSlot: SlotFixture = {
  model_id: 'capped-ref',
  media_slots: [
    { slotId: 'reference_image', fieldKey: 'referenceImage', required: false, maxFiles: 2, mediaKind: 'image', label: '参考图' },
  ],
};

/** 默认多张位放满、单张位还有余量。 */
const cappedMultiPlusSingle: SlotFixture = {
  model_id: 'capped-mixed',
  media_slots: [
    { slotId: 'first_frame', fieldKey: 'firstFrameImage', required: false, maxFiles: 1, mediaKind: 'image', label: '首帧' },
    { slotId: 'reference_image', fieldKey: 'referenceImage', required: false, maxFiles: 1, mediaKind: 'image', label: '参考图' },
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

  it('模型媒体能力：有位且含该类型 → supported；有位但不含 → unsupported；无位/缺省 → no-slot-model', () => {
    expect(resolveMediaSupport(twoSingleSlots, 'image')).toBe('supported');
    expect(resolveMediaSupport(twoSingleSlots, 'video')).toBe('unsupported');
    expect(resolveMediaSupport(twoSingleSlots, 'audio')).toBe('unsupported');
    // 无素材位（纯文生图/文生视频）= 无用途模型，沿用既有允许加入的口径
    expect(resolveMediaSupport({ media_slots: [] }, 'video')).toBe('no-slot-model');
    expect(resolveMediaSupport(undefined, 'image')).toBe('no-slot-model');
    expect(resolveMediaSupport(null, 'audio')).toBe('no-slot-model');
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

  it('存量兜底（§8）：唯一候选但只能放一张时**不**绑（与 §4.3 默认落位的唯一差别）', () => {
    const onlyFirst: SlotFixture = {
      model_id: 'only-first',
      media_slots: [
        { slotId: 'first_frame', fieldKey: 'firstFrameImage', required: true, maxFiles: 1, mediaKind: 'image', label: '首帧' },
      ],
    };
    // §4.3「加入参考」：唯一去处，直接绑
    expect(defaultSlotId(onlyFirst, 'image')).toBe('first_frame');
    // §8「存量/脚本引用没表达用途」：不替调用方认定它是首帧
    expect(legacySlotId(onlyFirst, 'image')).toBeNull();
  });

  it('存量兜底（§8）：存在多张位时绑该位，与 §4.3 一致', () => {
    expect(legacySlotId(oneMultiSlot, 'image')).toBe('reference_image');
    expect(legacySlotId(mixedSlots, 'image')).toBe('reference_image');
    expect(legacySlotId(twoSingleSlots, 'image')).toBeNull();
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

describe('用途张数（容量）', () => {
  const slotOf = (entry: SlotFixture, slotId: string) => {
    const slot = entry.media_slots.find((candidate) => candidate.slotId === slotId);
    if (slot === undefined) throw new Error(`fixture 缺少素材位 ${slotId}`);
    return slot;
  };

  it('绑定条数与余量按用途位分别计算', () => {
    const refs = [makeRef('a', 'reference_image'), makeRef('b', 'reference_image'), makeRef('c', null)];
    const slot = slotOf(cappedMultiSlot, 'reference_image');
    expect(slotBindingCount(refs, slot)).toBe(2);
    expect(slotHasRoom(slot, refs)).toBe(false);
    expect(slotHasRoom(slot, refs.slice(0, 1))).toBe(true);
  });

  it('单张位加入第二张即放满（加入路径不再双占）', () => {
    const onlyFirst: SlotFixture = { model_id: 'only-first', media_slots: [slotOf(twoSingleSlots, 'first_frame')] };
    const refs = [makeRef('a', 'first_frame')];
    expect(resolveAddPlacement(onlyFirst, 'image', refs)).toEqual({
      kind: 'full',
      mediaType: 'image',
      capacity: 1,
    });
    expect(resolveAddPlacement(onlyFirst, 'image', [])).toEqual({
      kind: 'slot',
      slotId: 'first_frame',
    });
  });

  it('多张位还有余量 → 直接绑定；放满 → 拒绝加入并给出该媒体类型的总容量', () => {
    const slot = slotOf(cappedMultiSlot, 'reference_image');
    expect(resolveAddPlacement(cappedMultiSlot, 'image', [makeRef('a', slot.slotId)])).toEqual({
      kind: 'slot',
      slotId: 'reference_image',
    });
    expect(
      resolveAddPlacement(cappedMultiSlot, 'image', [
        makeRef('a', slot.slotId),
        makeRef('b', slot.slotId),
      ]),
    ).toEqual({ kind: 'full', mediaType: 'image', capacity: 2 });
  });

  it('默认多张位放满但别的候选位还有余量 → 落未指定（保住「先加后标」流程）', () => {
    const refs = [makeRef('a', 'reference_image')];
    expect(resolveAddPlacement(cappedMultiPlusSingle, 'image', refs)).toEqual({
      kind: 'unspecified',
    });
  });

  it('没有用途模型的媒体类型 → 落未指定（用途域不参与）', () => {
    const noSlots: SlotFixture = { model_id: 't2v', media_slots: [] };
    expect(resolveAddPlacement(noSlots, 'image', [])).toEqual({ kind: 'unspecified' });
  });

  it('绑定数超过声明张数 → 一条 slot-over-capacity（模型切换 / 改小张数 / 复用的兜底）', () => {
    const refs = [
      makeRef('a', 'reference_image'),
      makeRef('b', 'reference_image'),
      makeRef('c', 'reference_image'),
    ];
    const problems = collectSlotProblems(refs, cappedMultiSlot);
    const over = problems.filter((problem) => problem.kind === 'slot-over-capacity');
    assert.equal(over.length, 1);
    expect(over[0]).toMatchObject({
      slotId: 'reference_image',
      fieldKey: 'referenceImage',
      label: '参考图',
      count: 3,
      maxFiles: 2,
    });
    // 超量位上的图都指定了用途，不再重复报「未指定」。
    expect(problems.filter((problem) => problem.kind === 'unspecified-reference')).toHaveLength(0);
  });

  it('恰好等于上限 → 不报超量', () => {
    const refs = [makeRef('a', 'reference_image'), makeRef('b', 'reference_image')];
    expect(collectSlotProblems(refs, cappedMultiSlot)).toEqual([]);
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

  it('用途在当前模型上不存在 → 一条 slot-not-in-model，且不再算作未指定', () => {
    // 模型切换后残留的用途：last_frame 在只有多张参考位的模型上不存在。
    const problems = collectSlotProblems([makeRef('a', 'last_frame')], oneMultiSlot);
    const notInModel = problems.filter((p) => p.kind === 'slot-not-in-model');
    assert.equal(notInModel.length, 1);
    expect(notInModel[0]).toMatchObject({ refId: 'a', slotId: 'last_frame', mediaType: 'image' });
    // 互斥：同一张图不会既报「用途不存在」又报「未指定」。
    expect(problems.filter((p) => p.kind === 'unspecified-reference')).toHaveLength(0);
  });

  it('媒体类型在模型上完全没有候选位 → 不报 slot-not-in-model（由不兼容参考承载）', () => {
    // twoSingleSlots 只声明 image；引用是 video 时由 incompatible-reference 一类判据负责。
    const videoRef = { ...makeRef('a', 'first_frame'), mediaType: 'video' as const };
    expect(collectSlotProblems([videoRef], twoSingleSlots)).toEqual([]);
  });
});
