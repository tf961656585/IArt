import assert from 'node:assert/strict';
import test from 'node:test';

import type { GenerationMediaSlotId } from '@iart/contracts';
import { GENERATION_FAMILY_ADAPTER_IDS } from '@iart/contracts';
import {
  buildFamilyTemplateParameterDescriptor,
  buildFamilyTemplateSources,
  getFamilyTemplate,
  requireFamilyTemplate,
} from '../generation-family-templates.registry.cts';
import {
  buildFormatParameterDescriptor,
  composeFormatSources,
  loadPresetFormats,
} from '../interface-format/registry.cts';

/**
 * 门面等价测试（2026-10-26 运行时切换批次）。
 *
 * 生产消费方（投影、目录、写入守卫、描述符端点）全部经
 * `generation-family-templates.registry.cts` 这个**门面**访问接口格式；门面内部已改为
 * 委派实体（`interface-format/registry.cts`），旧的一族一份 TypeScript 工厂不再被生产引用。
 * 本文件钉住「门面 ≢ 另一套实现，只是实体的薄翻译」：
 *
 * ① 合成 sources：对 8 个格式 × 全部合法素材位子集，门面的 `buildFamilyTemplateSources`
 *    与实体的 `composeFormatSources` 逐字段深相等（含参数覆盖与配方路径的传递）；
 * ② 参数描述符：门面描述符去掉「素材位行 + 格式能力字段」后必须与实体描述符逐字段相等——
 *    这两项是门面在分发处统一补填的（实体描述符服务于逐族等价矩阵，形状不含它们），
 *    补填内容必须来自预设自身（`media.supports` / `media.required` / `media.slots`）；
 * ③ 边界：未知 id → `unknown` / null，不回落任何已登记格式；越界素材位在门面侧是
 *    「收窄后继续合成」（既有语义），与实体层的「显式拒绝」是两种入口语义，不得混用。
 */

const MODEL_ID = 'declared-facade-equivalence';

/** 幂集（保持 `supports` 声明顺序，与合成期排序口径一致）。 */
const buildPowerSet = (slots: readonly GenerationMediaSlotId[]): GenerationMediaSlotId[][] => {
  const subsets: GenerationMediaSlotId[][] = [];
  for (let mask = 0; mask < 1 << slots.length; mask += 1) {
    const subset: GenerationMediaSlotId[] = [];
    slots.forEach((slotId, index) => {
      if ((mask & (1 << index)) !== 0) subset.push(slotId);
    });
    subsets.push(subset);
  }
  return subsets;
};

const subsetLabel = (acceptedMediaSlots: readonly GenerationMediaSlotId[]): string =>
  acceptedMediaSlots.length === 0 ? '<没有素材位>' : acceptedMediaSlots.join('+');

const presetFormats = loadPresetFormats();

void test('预设清单：门面注册表恰覆盖全部 8 条内置接口格式', () => {
  assert.equal(presetFormats.length, 8, '内置接口格式应为 8 条');
  assert.deepEqual(
    [...presetFormats.map((format) => format.format_id)],
    [...GENERATION_FAMILY_ADAPTER_IDS],
    '预设清单与契约的预设 id 快照必须同序同集（快照漂移应在这里暴露）',
  );
  for (const format of presetFormats) {
    const entry = getFamilyTemplate(format.format_id);
    assert.ok(entry !== null, `${format.format_id} 必须能在门面注册表里取到`);
    assert.equal(entry.familyAdapterId, format.format_id);
    assert.equal(entry.status, format.status);
    assert.deepEqual([...entry.supportsMediaSlots], [...format.media.supports]);
    assert.deepEqual([...entry.requiredMediaSlots], [...format.media.required]);
    assert.deepEqual(
      entry.mediaSlotFieldKeys,
      Object.fromEntries(Object.entries(format.media.slots).map(([slotId, slot]) => [slotId, slot.field_key])),
      `${format.format_id}: 素材位字段键必须直接来自预设（不手抄字面量）`,
    );
    assert.deepEqual(
      [...entry.declaredEndpointKeys],
      Object.keys(format.transport.endpoints),
      `${format.format_id}: endpoint 键集必须来自预设的 transport.endpoints`,
    );
  }
});

// ---------------------------------------------------------------------------
// ① 合成 sources：门面 ≡ 实体
// ---------------------------------------------------------------------------

for (const format of presetFormats) {
  const formatId = format.format_id;
  const legalSubsets = buildPowerSet(format.media.supports).filter((subset) =>
    format.media.required.every((requiredSlot) => subset.includes(requiredSlot)),
  );

  for (const acceptedMediaSlots of legalSubsets) {
    void test(`[${formatId}] 门面 sources ≡ 实体 sources（${subsetLabel(acceptedMediaSlots)}）`, () => {
      const facade = buildFamilyTemplateSources(formatId, MODEL_ID, { acceptedMediaSlots });
      const entity = composeFormatSources(formatId, MODEL_ID, { acceptedMediaSlots });

      assert.equal(entity.kind, 'ready');
      if (entity.kind !== 'ready') throw new Error('unreachable: entity compose not ready');
      assert.equal(facade.kind, 'ready');
      if (facade.kind !== 'ready') throw new Error('unreachable: facade build not ready');

      assert.equal(facade.familyAdapterId, formatId);
      assert.deepStrictEqual(facade.sources.runtimeModel, entity.sources.runtimeModel);
      assert.deepStrictEqual(facade.sources.node, entity.sources.node);
      assert.deepStrictEqual(facade.sources.localizationResources, entity.sources.localizationResources);
    });
  }
}

void test('门面 sources 透传参数覆盖与配方（与实体的合成顺序一致）', () => {
  const entityFormatIds = presetFormats.map((format) => format.format_id);
  for (const formatId of entityFormatIds) {
    const acceptedMediaSlots = requireFamilyTemplate(formatId).supportsMediaSlots;
    const facade = buildFamilyTemplateSources(formatId, MODEL_ID, {
      acceptedMediaSlots,
      parameterOverrides: { official: [], custom: [] },
      recipe: null,
    });
    const entity = composeFormatSources(formatId, MODEL_ID, {
      acceptedMediaSlots,
      parameterOverrides: { official: [], custom: [] },
      recipe: null,
    });
    assert.equal(facade.kind, 'ready');
    assert.equal(entity.kind, 'ready');
    if (facade.kind !== 'ready' || entity.kind !== 'ready') throw new Error('unreachable: not ready');
    assert.deepStrictEqual(facade.sources, entity.sources, `${formatId}: 覆盖与配方的传递必须与实体一致`);
  }
});

// ---------------------------------------------------------------------------
// ② 参数描述符：门面 = 实体描述符 + 预设能力补填
// ---------------------------------------------------------------------------

for (const format of presetFormats) {
  const formatId = format.format_id;

  void test(`[${formatId}] 门面描述符 ≡ 实体描述符 + 素材位行/能力字段`, () => {
    const entity = buildFormatParameterDescriptor(formatId);
    const facade = buildFamilyTemplateParameterDescriptor(formatId);
    assert.equal(entity.kind, 'ready');
    assert.equal(facade.kind, 'ready');
    if (entity.kind !== 'ready' || facade.kind !== 'ready') throw new Error('unreachable: not ready');

    assert.equal(facade.familyAdapterId, formatId);
    assert.equal(facade.descriptor.family_adapter_id, formatId);

    // 素材位行由门面补填，且必须来自预设 `media.slots`（位标识 → 字段键）。
    const mediaRows = facade.descriptor.official_fields.filter((field) => field.media_slot_id !== undefined);
    assert.deepEqual(
      mediaRows.map((field) => field.media_slot_id),
      Object.keys(format.media.slots),
      `${formatId}: 素材位行必须按预设的 slots 顺序前置`,
    );
    for (const [slotId, slot] of Object.entries(format.media.slots)) {
      const row = mediaRows.find((field) => field.media_slot_id === slotId);
      assert.ok(row !== undefined, `${formatId}: 缺少素材位 ${slotId} 的描述行`);
      assert.equal(row.field_key, slot.field_key, `${formatId}.${slotId}: 字段键必须等于预设声明`);
    }

    // 能力字段由门面补填，值必须来自预设能力事实。
    assert.deepEqual([...facade.descriptor.supports_media_slots], [...format.media.supports]);
    assert.deepEqual([...facade.descriptor.required_media_slots], [...format.media.required]);

    // 去掉补填项后，其余字段必须与实体描述符逐字段相等（保留键推导方式不得漂移）。
    const nonMediaRows = facade.descriptor.official_fields.filter((field) => field.media_slot_id === undefined);
    assert.deepStrictEqual(
      nonMediaRows,
      entity.descriptor.official_fields,
      `${formatId}: 非素材位官方参数区必须与实体逐字段相等（含顺序）`,
    );
    // 把三项补填换回实体的原值后，整份描述符必须与实体逐字段相等（不允许门面夹带别的差异）。
    assert.deepStrictEqual(
      {
        ...facade.descriptor,
        official_fields: entity.descriptor.official_fields,
        supports_media_slots: entity.descriptor.supports_media_slots,
        required_media_slots: entity.descriptor.required_media_slots,
      },
      entity.descriptor,
      `${formatId}: 门面描述符与实体描述符的差异只允许出现在素材位行与能力字段`,
    );
  });
}

// ---------------------------------------------------------------------------
// ③ 边界
// ---------------------------------------------------------------------------

void test('未知 id：门面查表返回 null，合成与描述符返回 unknown（不回落任何格式）', () => {
  assert.equal(getFamilyTemplate('kling-v1'), null);
  assert.equal(getFamilyTemplate('not-a-format'), null);
  assert.deepEqual(buildFamilyTemplateSources('kling-v1', MODEL_ID, { acceptedMediaSlots: [] }), {
    kind: 'unknown',
  });
  assert.deepEqual(buildFamilyTemplateParameterDescriptor('kling-v1'), { kind: 'unknown' });
});

void test('越界素材位：门面按既有语义收窄后合成（实体入口保持显式拒绝）', () => {
  // kling-text2video-v1 一个素材位都不支持：门面收到越界位时按能力过滤（留痕），
  // 结果与「不带素材位」同形；实体入口对同一输入是显式拒绝，两者语义刻意不同。
  const formatId = 'kling-text2video-v1';
  const facade = buildFamilyTemplateSources(formatId, MODEL_ID, {
    acceptedMediaSlots: ['reference_image', 'first_frame'],
  });
  const entity = composeFormatSources(formatId, MODEL_ID, { acceptedMediaSlots: [] });
  assert.equal(facade.kind, 'ready');
  assert.equal(entity.kind, 'ready');
  if (facade.kind !== 'ready' || entity.kind !== 'ready') throw new Error('unreachable: not ready');
  assert.deepStrictEqual(facade.sources, entity.sources);

  assert.equal(
    composeFormatSources(formatId, MODEL_ID, { acceptedMediaSlots: ['first_frame'] }).kind,
    'unsupported_media_slots',
    '实体入口必须保持显式拒绝（越界不静默）',
  );
});
