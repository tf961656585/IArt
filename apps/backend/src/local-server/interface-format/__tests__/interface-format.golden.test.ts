import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { GENERATION_FAMILY_ADAPTER_IDS, type GenerationMediaSlotId } from '@iart/contracts';
import {
  buildFormatParameterDescriptor,
  composeFormatSources,
  loadPresetFormats,
} from '../registry.cts';

import goldenJson from './__fixtures__/interface-format.golden.json';

/**
 * 接口格式 golden 门禁（**等价性的唯一机械保护**）。
 *
 * 背景：2026-10-26 之前，8 个接口格式的协议语义由一族一份的 TypeScript 工厂承载，等价性靠
 * 「实体合成 vs 旧构建器逐字段深相等」保护；旧族文件删除后，那份 oracle 不存在了，本文件用
 * 一份**从已验证一致的形态**固化的 golden fixture 接替它：
 *
 * - fixture 由一次性脚本生成（先断言实体合成 ≡ 旧构建器，再对合成结果做规范化 JSON 的
 *   SHA-256）；快照文件 `__fixtures__/snapshots/<formatId>.json` 保存每族最大子集的完整
 *   sources，仅供排障对照，不参与断言。
 * - 每个格式 × 全部合法素材位子集（83 组）各有一条 sources hash；每个格式一条描述符 hash。
 * - 规范化口径：递归按键排序、数组保序、`undefined` 键剔除，再做 `JSON.stringify`。任何
 *   「键顺序不同但语义相同」的改动不应红，任何实际值改动必须红。
 *
 * 重新生成方式（改了任何预设或合成器之后）：
 * 1. 在 `apps/backend` 下临时写一个脚本，逐格式逐合法子集调用 `composeFormatSources`
 *    与 `buildFormatParameterDescriptor`，按本文件同一套 `canonicalize` / `sha256` 计算；
 * 2. 生成前必须先证明「新产物是预期的」——对照本 fixture 的差异逐条解释，不要盲刷；
 * 3. 写出 `__fixtures__/interface-format.golden.json` 与 `__fixtures__/snapshots/<id>.json`；
 * 4. 删除临时脚本（golden 是事实记录，生成脚本不留在仓库里）。
 *
 * 注意：golden 只保护「今天固化的形态不变」，不是「形态正确」的证明；语义正确性由逐族行为
 * 测试（`generation-family-template.*.test.ts`）与预设 schema 承担。
 */

type GoldenSubset = { slots: string[]; sources_sha256: string };
type GoldenFormat = { descriptor_sha256: string; subsets: GoldenSubset[] };
type GoldenFixture = {
  schema_version: number;
  model_id_seed: string;
  formats: Record<string, GoldenFormat>;
};

const golden = goldenJson as GoldenFixture;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      // `undefined` 键不参与序列化（与 JSON.stringify 的语义一致），先剔除再排序。
      if (item === undefined) continue;
      sorted[key] = canonicalize(item);
    }
    return sorted;
  }
  return value;
};

const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');

const subsetLabel = (slots: readonly string[]): string => (slots.length === 0 ? '<没有素材位>' : slots.join('+'));

/** 幂集（保持 `supports` 声明顺序，与合成期口径一致）。 */
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

void test('golden fixture 结构：schema_version / model_id_seed / 8 族齐全', () => {
  assert.equal(golden.schema_version, 1);
  assert.equal(typeof golden.model_id_seed, 'string');
  assert.ok(golden.model_id_seed.length > 0);
  assert.deepEqual(
    Object.keys(golden.formats).sort(),
    [...GENERATION_FAMILY_ADAPTER_IDS].sort(),
    'golden 必须覆盖全部已登记格式，且不得残留已退役格式',
  );
});

for (const format of loadPresetFormats()) {
  const formatId = format.format_id;

  void test(`[${formatId}] 全部合法素材位子集的 sources 与 golden 一致`, () => {
    const goldenFormat = golden.formats[formatId];
    assert.ok(goldenFormat, `${formatId} 在 golden 里没有条目`);

    // 合法子集 = 幂集 ∩ 含全部必选位；slots 取 `media.supports` 顺序。
    const legalSubsets = buildPowerSet(format.media.supports)
      .filter((subset) => format.media.required.every((required) => subset.includes(required)))
      .map((subset) => format.media.supports.filter((slotId) => subset.includes(slotId)));

    assert.deepEqual(
      goldenFormat.subsets.map((subset) => subset.slots),
      legalSubsets.map((subset) => [...subset]),
      `${formatId} 的 golden 子集清单必须与当前预设的合法子集一一对应（顺序也一致）`,
    );

    for (const subset of goldenFormat.subsets) {
      const slots = subset.slots as GenerationMediaSlotId[];
      const composed = composeFormatSources(formatId, golden.model_id_seed, {
        acceptedMediaSlots: slots,
      });
      assert.equal(composed.kind, 'ready', `${formatId} ${subsetLabel(slots)} 合成未就绪`);
      if (composed.kind !== 'ready') throw new Error('unreachable: compose not ready');
      assert.equal(
        sha256(composed.sources),
        subset.sources_sha256,
        `${formatId} ${subsetLabel(slots)} 的 sources 与 golden 不一致`,
      );
    }
  });

  void test(`[${formatId}] 参数描述符与 golden 一致`, () => {
    const goldenFormat = golden.formats[formatId];
    assert.ok(goldenFormat, `${formatId} 在 golden 里没有条目`);
    const result = buildFormatParameterDescriptor(formatId);
    assert.equal(result.kind, 'ready', `${formatId} 描述符未就绪`);
    if (result.kind !== 'ready') throw new Error('unreachable: descriptor not ready');
    assert.equal(
      sha256(result.descriptor),
      goldenFormat.descriptor_sha256,
      `${formatId} 的参数描述符与 golden 不一致`,
    );
  });
}
