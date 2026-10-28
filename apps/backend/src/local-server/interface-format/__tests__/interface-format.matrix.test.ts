import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GENERATION_FAMILY_ADAPTER_IDS,
  type GenerationMediaSlotId,
} from '@iart/contracts';
import { requireFamilyTemplate } from '../../generation-family-templates.registry.cts';
import { assertNoMacroResidue } from '../macros.cts';
import { assertNoPlaceholderResidue } from '../placeholder.cts';
import {
  buildFormatParameterDescriptor,
  composeFormatSources,
  getInterfaceFormat,
  loadPresetFormats,
} from '../registry.cts';

/**
 * 8 族接口格式矩阵门禁（**全量**，逐族穷举全部合法素材位子集）。
 *
 * 与 `interface-format.golden.test.ts` 的分工：golden 钉住「每个子集 / 每个描述符的产物
 * 逐字节未变」；本文件经 **registry**（`loadPresetFormats` / `getInterfaceFormat` /
 * `composeFormatSources` / `buildFormatParameterDescriptor`）钉住「登记是完整的、分发链路
 * 对 8 个格式都成立、产物没有声明期残留」——预设文件与 manifest 少登记一条、order 漂移、
 * 某子集合成失败、占位符 / 宏漏到运行时事实，都会在这里当场变红。
 *
 * 覆盖五件事：
 * ① 清单完整性：`loadPresetFormats()` 恰为 `GENERATION_FAMILY_ADAPTER_IDS` 全集的 8 条，
 *    order 单调、与枚举位置 ×10 同值、无重复；
 * ② 逐族幂集穷举（过滤掉缺必选位的子集）：每个合法子集都能合成 sources，且无占位符 / 宏残留；
 * ③ 描述符可用：逐族给出 ready 描述符，保留键排序（内容由 golden hash 钉住）；
 * ④ 端点一致性：格式声明的每个端点值（含异步轮询解析出的 url_template）都在适配器契约的
 *    `relative_endpoints` 值集合里；
 * ⑤ 边界：未知 id → `unknown`，越界素材位 → `unsupported_media_slots`（不回落、不静默）。
 */

const MODEL_ID_PREFIX = 'declared-format-matrix';

const subsetLabel = (acceptedMediaSlots: readonly GenerationMediaSlotId[]): string =>
  acceptedMediaSlots.length === 0 ? '<没有素材位>' : acceptedMediaSlots.join('+');

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

const readyFamilyEntry = (formatId: string) => {
  const entry = requireFamilyTemplate(formatId);
  if (entry.status !== 'ready') {
    throw new Error(`family template is not ready: ${formatId}`);
  }
  return entry;
};

/** 逐族合法素材位子集：幂集过滤掉缺 `required` 的形态（缺必选位的记录不是合法记录）。 */
const legalSlotSubsets = (formatId: string): GenerationMediaSlotId[][] => {
  const entry = readyFamilyEntry(formatId);
  return buildPowerSet(entry.supportsMediaSlots).filter((subset) =>
    entry.requiredMediaSlots.every((requiredSlot) => subset.includes(requiredSlot)),
  );
};

const expectedOrder = (formatId: string): number => {
  const index = GENERATION_FAMILY_ADAPTER_IDS.findIndex((adapterId) => adapterId === formatId);
  if (index < 0) throw new Error(`unknown format id: ${formatId}`);
  return (index + 1) * 10;
};

// ---------------------------------------------------------------------------
// ① 清单完整性
// ---------------------------------------------------------------------------

void test('预设清单恰为 8 族全集，order 单调且与枚举位置同值', () => {
  const formats = loadPresetFormats();
  const formatIds = formats.map((format) => format.format_id);

  assert.equal(formats.length, GENERATION_FAMILY_ADAPTER_IDS.length);
  assert.equal(formats.length, 8);
  assert.deepStrictEqual([...formatIds], [...GENERATION_FAMILY_ADAPTER_IDS]);
  assert.equal(new Set(formatIds).size, formatIds.length, '预设 id 不得重复');

  // order 规则：枚举位置 ×10（openai-image 10 → kling-omni 80）。manifest 与预设声明必须同值，
  // 否则 registry 会按 identity mismatch 静默丢弃该条——这里直接钉住「没有任何一条被丢弃」。
  formats.forEach((format, index) => {
    assert.equal(format.order, expectedOrder(format.format_id), `${format.format_id} 的 order 与枚举位置不符`);
    assert.ok(format.order >= 10 && format.order <= 80);
    if (index > 0) {
      const previous = formats[index - 1];
      if (previous === undefined) throw new Error('unreachable: previous format missing');
      assert.ok(previous.order < format.order, 'order 必须严格单调升序');
    }
    assert.equal(format.status, 'ready', `${format.format_id} 应为已就绪格式`);
    assert.equal(getInterfaceFormat(format.format_id).kind, 'ready');
  });
});

// ---------------------------------------------------------------------------
// ② 逐族穷举合法素材位子集
// ---------------------------------------------------------------------------

const coverage: Array<{ formatId: string; subsets: number }> = [];

for (const formatId of GENERATION_FAMILY_ADAPTER_IDS) {
  const entry = readyFamilyEntry(formatId);
  const subsets = legalSlotSubsets(formatId);
  coverage.push({ formatId, subsets: subsets.length });

  void test(`[${formatId}] 合法素材位子集清单自洽（${subsets.length} 种）`, () => {
    // 含全部必选位的子集数 = 2^(supports - required)：必选位之外每位可自由取舍。
    assert.equal(subsets.length, 1 << (entry.supportsMediaSlots.length - entry.requiredMediaSlots.length));
    assert.ok(subsets.length >= 1);
    const labels = new Set(subsets.map(subsetLabel));
    assert.equal(labels.size, subsets.length, '合法子集不得重复');
    for (const subset of subsets) {
      for (const requiredSlot of entry.requiredMediaSlots) {
        assert.ok(subset.includes(requiredSlot), `${subsetLabel(subset)} 缺少必选素材位 ${requiredSlot}`);
      }
      assert.deepStrictEqual(
        subset,
        entry.supportsMediaSlots.filter((slotId) => subset.includes(slotId)),
        '子集必须保持 supports 声明顺序',
      );
    }
  });

  for (const acceptedMediaSlots of subsets) {
    void test(`[${formatId}] 合成 sources 可用且无声明期残留（${subsetLabel(acceptedMediaSlots)}）`, () => {
      const modelId = `${MODEL_ID_PREFIX}-${formatId}`;
      const result = composeFormatSources(formatId, modelId, { acceptedMediaSlots });
      assert.equal(result.kind, 'ready');
      if (result.kind !== 'ready') throw new Error('unreachable: compose not ready');
      assert.equal(result.formatId, formatId);

      // 逐子集的产物内容（含与旧族构建器的等价性）由 golden hash 钉住；这里钉的是「每个子集
      // 都真的能合成，且产物里没有声明期语法」——预设新增子集而没补 golden 时，golden 的
      // 子集清单断言会先红，两边不会互相掩盖。
      assertNoPlaceholderResidue(result.sources);
      assertNoMacroResidue(result.sources);
      assert.equal(JSON.stringify(result.sources).includes('{{'), false);
    });
  }
}

void test('矩阵覆盖的合法子集总数（逐族穷举，无一遗漏）', () => {
  const total = coverage.reduce((sum, item) => sum + item.subsets, 0);
  // 逐族：openai-image 2、openai-video 8、gemini 2、seedance 32、veo 4、text2video 1、
  // image2video 2（4 种幂集里 2 种缺必选首帧）、omni 32 = 83。
  assert.deepStrictEqual(coverage, [
    { formatId: 'openai-image-v1', subsets: 2 },
    { formatId: 'openai-video-v1', subsets: 8 },
    { formatId: 'gemini-image-interactions-v1', subsets: 2 },
    { formatId: 'seedance-2-0-v1', subsets: 32 },
    { formatId: 'veo-v1', subsets: 4 },
    { formatId: 'kling-text2video-v1', subsets: 1 },
    { formatId: 'kling-image2video-v1', subsets: 2 },
    { formatId: 'kling-omni-video-v1', subsets: 32 },
  ]);
  assert.equal(total, 83);
});

// ---------------------------------------------------------------------------
// ③ 描述符等价
// ---------------------------------------------------------------------------

for (const formatId of GENERATION_FAMILY_ADAPTER_IDS) {
  void test(`[${formatId}] 参数描述符可用且保留键稳定`, () => {
    const result = buildFormatParameterDescriptor(formatId);
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') throw new Error('unreachable: descriptor not ready');
    assert.equal(result.formatId, formatId);
    assert.equal(result.descriptor.family_adapter_id, formatId);

    // 描述符内容（字段、文案解析、保留键集合）由 golden hash 钉住；这里只钉「描述符是稳定
    // 投影」这一条形状约定：保留键必须排序，不随集合插入顺序漂移。
    assert.deepEqual(
      [...result.descriptor.reserved_wire_names.body],
      [...result.descriptor.reserved_wire_names.body].sort(),
      '保留键必须排序（描述符是稳定投影，不随集合插入顺序漂移）',
    );
  });
}

// ---------------------------------------------------------------------------
// ④ 端点自洽（2026-10-27 生成侧适配器退场后，格式实体是端点的唯一事实源）
// ---------------------------------------------------------------------------

void test('每个格式的端点都是自包含相对路径，提交与轮询键都能解析', () => {
  for (const formatId of GENERATION_FAMILY_ADAPTER_IDS) {
    const lookup = getInterfaceFormat(formatId);
    assert.equal(lookup.kind, 'ready');
    if (lookup.kind !== 'ready') throw new Error('unreachable: format not ready');
    const format = lookup.format;
    const endpoints = format.transport.endpoints;

    assert.ok(Object.keys(endpoints).length > 0, `${formatId} 必须声明端点表`);
    for (const [endpointKey, endpointPath] of Object.entries(endpoints)) {
      assert.ok(
        endpointPath.startsWith('/'),
        `${formatId}.${endpointKey} 必须是相对路径（不得包含 host）: ${endpointPath}`,
      );
    }

    const submitKey = format.transport.submit.endpoint_key;
    assert.ok(
      Object.hasOwn(endpoints, submitKey),
      `${formatId} 的提交端点键 ${submitKey} 未在端点表中声明`,
    );

    const polling = format.transport.async?.polling;
    if (polling === undefined) continue;
    if (polling.endpoint_key !== undefined) {
      assert.ok(
        Object.hasOwn(endpoints, polling.endpoint_key),
        `${formatId} 的轮询端点键 ${polling.endpoint_key} 未在端点表中声明`,
      );
    }
    const pollingUrl =
      polling.url_template ??
      (polling.endpoint_key === undefined ? undefined : endpoints[polling.endpoint_key]);
    assert.ok(pollingUrl !== undefined, `${formatId} 的轮询地址无法解析`);
    assert.ok(pollingUrl.startsWith('/'), `${formatId} 的轮询地址必须是相对路径: ${pollingUrl}`);
  }
});

// ---------------------------------------------------------------------------
// ⑤ 边界
// ---------------------------------------------------------------------------

void test('未知 id → unknown（不回落任何已登记格式）', () => {
  assert.equal(getInterfaceFormat('format-does-not-exist-v1').kind, 'unknown');
  assert.equal(buildFormatParameterDescriptor('format-does-not-exist-v1').kind, 'unknown');
  assert.deepStrictEqual(
    composeFormatSources('format-does-not-exist-v1', `${MODEL_ID_PREFIX}-unknown`, {
      acceptedMediaSlots: [],
    }),
    { kind: 'unknown' },
  );
});

void test('越界素材位 → unsupported_media_slots（点名拒绝，不静默过滤）', () => {
  // kling-text2video-v1 一个素材位都不支持：任何位都是越界。
  const result = composeFormatSources('kling-text2video-v1', `${MODEL_ID_PREFIX}-boundary`, {
    acceptedMediaSlots: ['reference_image', 'first_frame'],
  });
  assert.equal(result.kind, 'unsupported_media_slots');
  if (result.kind !== 'unsupported_media_slots') throw new Error('unreachable: not refused');
  assert.equal(result.formatId, 'kling-text2video-v1');
  assert.deepStrictEqual(result.unsupportedMediaSlots, ['reference_image', 'first_frame']);
});
