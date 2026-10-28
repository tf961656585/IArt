/**
 * 族模板注册表「素材位 → 参数字段键」出口的一致性测试。
 *
 * 钉住的不变量（改族时漏改任一处都会在这里红）：
 * - `mediaSlotFieldKeys` 的键集必须等于该族 `supportsMediaSlots` 的集合——少一位说明能力事实
 *   漏登记（界面选不到该用途），多一位说明登记了族表达不了的位（能选但提交必失败）；
 * - `requiredMediaSlots` 必须是 `supportsMediaSlots` 的子集；
 * - 每个登记了映射的位，字段键必须非空字符串；
 * - 可灵图生视频族的首帧/尾帧字段键必须与其协议事实表一致（该族是「必填首帧」的唯一族，
 *   字段键接错会让设计里「用途标了却进错位」的缺陷重新出现）。
 *
 * 为什么必须遍历全部 ready 族而不是逐个硬写：注册表新增族时，只测已知族会让新族静默漏登记。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GENERATION_FAMILY_TEMPLATE_REGISTRY,
  requireFamilyTemplate,
  type GenerationFamilyTemplateEntry,
} from '../generation-family-templates.registry.cts';

const readyEntries: ReadonlyArray<[string, GenerationFamilyTemplateEntry]> = Object.entries(
  GENERATION_FAMILY_TEMPLATE_REGISTRY,
).filter((entryPair): entryPair is [string, GenerationFamilyTemplateEntry] => {
  const entry = entryPair[1];
  return entry !== null && entry !== undefined && entry.status === 'ready';
});

void test('注册表：至少有一个 ready 族（防遍历空集假绿）', () => {
  assert.ok(readyEntries.length > 0, 'ready 族数量必须大于 0，否则下面的遍历断言全部空转');
});

void test('注册表：mediaSlotFieldKeys 键集等于 supportsMediaSlots', () => {
  for (const [id, entry] of readyEntries) {
    const mapKeys = Object.keys(entry.mediaSlotFieldKeys).filter(
      (key) => entry.mediaSlotFieldKeys[key as keyof typeof entry.mediaSlotFieldKeys] !== undefined,
    );
    assert.deepEqual(
      [...mapKeys].sort(),
      [...entry.supportsMediaSlots].sort(),
      `族 ${id} 的 mediaSlotFieldKeys 键集与 supportsMediaSlots 不一致：` +
        `映射 ${mapKeys.join(',') || '(空)'} vs 能力 ${entry.supportsMediaSlots.join(',') || '(空)'}`,
    );
  }
});

void test('注册表：requiredMediaSlots 是 supportsMediaSlots 的子集', () => {
  for (const [id, entry] of readyEntries) {
    const supported = new Set(entry.supportsMediaSlots);
    for (const slot of entry.requiredMediaSlots) {
      assert.ok(
        supported.has(slot),
        `族 ${id} 的必选位 ${slot} 不在 supportsMediaSlots 内（必选却不可表达）`,
      );
    }
  }
});

void test('注册表：每个登记位的字段键都是非空字符串', () => {
  for (const [id, entry] of readyEntries) {
    for (const [slot, fieldKey] of Object.entries(entry.mediaSlotFieldKeys)) {
      assert.equal(
        typeof fieldKey,
        'string',
        `族 ${id} 的位 ${slot} 字段键类型必须是字符串`,
      );
      assert.ok(
        typeof fieldKey === 'string' && fieldKey.trim().length > 0,
        `族 ${id} 的位 ${slot} 字段键不得为空——空键会投影成一个点不出参数的用途`,
      );
    }
  }
});

void test('可灵图生视频族：首帧/尾帧字段键与协议事实表一致', () => {
  const entry = requireFamilyTemplate('kling-image2video-v1');
  assert.equal(entry.status, 'ready', '可灵图生视频族必须已就绪');
  assert.equal(
    entry.mediaSlotFieldKeys.first_frame,
    'firstFrameImage',
    '首帧字段键必须是 firstFrameImage',
  );
  assert.equal(
    entry.mediaSlotFieldKeys.last_frame,
    'lastFrameImage',
    '尾帧字段键必须是 lastFrameImage',
  );
  assert.deepEqual(
    entry.requiredMediaSlots,
    ['first_frame'],
    '可灵图生视频族必须登记首帧为必选位',
  );
});

void test('可灵文生视频族：无素材位，映射为空', () => {
  const entry = requireFamilyTemplate('kling-text2video-v1');
  assert.equal(entry.status, 'ready');
  assert.deepEqual(entry.supportsMediaSlots, [], '文生视频族不该声明素材位');
  assert.deepEqual(
    Object.keys(entry.mediaSlotFieldKeys),
    [],
    '文生视频族不该登记素材位映射',
  );
});
