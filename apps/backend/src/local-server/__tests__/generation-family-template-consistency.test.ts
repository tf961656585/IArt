import assert from 'node:assert/strict';
import test from 'node:test';

import { ADAPTER_REGISTRY, GENERATION_FAMILY_ADAPTER_IDS, type GenerationFamilyAdapterId } from '@iart/contracts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';
import { GENERATION_FAMILY_TEMPLATE_REGISTRY, getFamilyTemplate } from '../generation-family-templates.registry.cts';

/**
 * 族模板注册表 ↔ 适配器一致性门禁（docs/custom-providers/生成模型自建声明试点-design.md §3.4，
 * D3：模板内置 endpoint + 与适配器声明的一致性门禁）。
 *
 * 2026-10-19 起接口类型由 1 个扩到 7 个，本门禁同步逐族化，钉三件事：
 * ① **注册表 7 键齐全**：键集必须与 contracts 的 `GENERATION_FAMILY_ADAPTER_IDS`（值域唯一
 *    owner）逐一对应。注册表类型已是 `Record<GenerationFamilyAdapterId, ...>`，少键在编译期
 *    就红；这里再钉一次是因为 `as const` 数组与 `Record` 的键集可能被同时删一格——两边一起
 *    改会让编译期保障失效，只有运行时比对能发现。
 * ② **ready 族的 endpoint 与适配器一致**：endpoint 事实源在 `packages/contracts`
 *    ADAPTER_REGISTRY 的 `relative_endpoints`，执行链消费的是族模板里的字面量。本测试把
 *    模板内所有 endpoint 分支收集起来，与注册表声明的 endpoint 键所指的路径逐一对齐——任一侧
 *    漂移即红（PC-02 遗留的双事实源在试点期的收口形态）。
 * ③ **pending 族显式标记**：未就绪族必须是 `status:'pending'`，且能力事实为空清单。这条防
 *    「忘了实现某族但测试全绿」：pending 是**显式状态**，不是「构建器抛错/返回空壳」这类
 *    无法与正常族区分的形态。
 */

/** 读一个 payload_rules 值节点上的字面量 endpoint（三种形态：literal / when 的两侧）。 */
const collectEndpointLiterals = (rule: unknown, into: Set<string>): void => {
  if (!isObjectRecord(rule)) return;
  const readValue = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) into.add(value);
  };
  readValue(rule.value);
  if (isObjectRecord(rule.truthy)) readValue(rule.truthy.value);
  if (isObjectRecord(rule.falsy)) readValue(rule.falsy.value);
};

/** 取模板 sources 的 runtime 段（模板由本仓构建，形状受控；仍按 unknown 收窄不用断言）。 */
const runtimeOf = (sources: { runtimeModel: { runtime: unknown } }): Record<string, unknown> => {
  const runtime = sources.runtimeModel.runtime;
  assert.ok(isObjectRecord(runtime) && !Array.isArray(runtime), 'template runtime must be an object');
  return runtime;
};

/** 取 runtime.payload_rules['api.endpoint'] 规则节点（提交端点规则）。 */
const endpointRuleOf = (runtime: Record<string, unknown>): Record<string, unknown> => {
  const payloadRules = runtime['payload_rules'];
  assert.ok(isObjectRecord(payloadRules) && !Array.isArray(payloadRules), 'template must carry payload_rules');
  const rule = payloadRules['api.endpoint'];
  assert.ok(isObjectRecord(rule) && !Array.isArray(rule), 'template must declare the api.endpoint rule');
  return rule;
};

/**
 * 收集一份模板 sources 里出现在「endpoint 位置」的全部字面量（含条件分支两侧）。
 *
 * 三类位置都要看：提交端点（`runtime.api_defaults.endpoint` / `request_strategy.endpoint` /
 * `runtime.payload_rules['api.endpoint']`）与**轮询查询端点**
 * （`runtimeModel.polling_strategy.request.url_template`）。异步族的两个 endpoint 键（seedance 的
 * `tasks` / `taskById`）分别落在两类位置上——只看提交端点的话，查询端点永远落在「模板未使用」
 * 这一侧，门禁就只能靠注册表自述，失去双向核对的意义。
 */
const collectTemplateEndpoints = (sources: {
  runtimeModel: Record<string, unknown> & { runtime: unknown };
}): Set<string> => {
  const endpoints = new Set<string>();
  const readEndpoint = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) endpoints.add(value);
  };
  const runtime = runtimeOf(sources);
  const apiDefaults = runtime['api_defaults'];
  if (isObjectRecord(apiDefaults)) readEndpoint(apiDefaults['endpoint']);
  const requestStrategy = runtime['request_strategy'];
  if (isObjectRecord(requestStrategy)) readEndpoint(requestStrategy['endpoint']);
  collectEndpointLiterals(endpointRuleOf(runtime), endpoints);
  const pollingStrategy = sources.runtimeModel['polling_strategy'];
  if (isObjectRecord(pollingStrategy) && isObjectRecord(pollingStrategy['request'])) {
    readEndpoint(pollingStrategy['request']['url_template']);
  }
  return endpoints;
};

void test('注册表键集 ≡ contracts 的 GENERATION_FAMILY_ADAPTER_IDS（7 族齐全，防两处漂移）', () => {
  const registryKeys = Object.keys(GENERATION_FAMILY_TEMPLATE_REGISTRY).sort();
  const contractIds = [...GENERATION_FAMILY_ADAPTER_IDS].sort();
  assert.deepEqual(registryKeys, contractIds, '族模板注册表必须与契约接口类型值域逐一对应');
  assert.equal(registryKeys.length, 7, '2026-10-19 起接口类型共 7 个');

  // 每个条目的 familyAdapterId 必须与自己的键一致（防止复制粘贴条目时漏改内部字段）
  for (const id of GENERATION_FAMILY_ADAPTER_IDS) {
    assert.equal(GENERATION_FAMILY_TEMPLATE_REGISTRY[id].familyAdapterId, id, `${id} 条目内部 id 必须与键一致`);
    assert.ok(getFamilyTemplate(id) !== null, `${id} 必须能按 id 取到注册条目`);
  }
  // 未知 id（已删掉的旧 id / 拼写错误）必须返回 null，而不是命中某个默认条目
  assert.equal(getFamilyTemplate('kling-v1'), null);
  assert.equal(getFamilyTemplate('not-a-family'), null);
});

void test('ready 族：模板 endpoint 与适配器 relative_endpoints 双向一致（现译逐族跑）', () => {
  let readyCount = 0;
  for (const familyAdapterId of GENERATION_FAMILY_ADAPTER_IDS) {
    const entry = GENERATION_FAMILY_TEMPLATE_REGISTRY[familyAdapterId];
    if (entry.status !== 'ready') continue;
    readyCount += 1;

    const adapter = ADAPTER_REGISTRY[familyAdapterId];
    assert.ok(adapter, `${familyAdapterId} 必须在 ADAPTER_REGISTRY 中登记`);
    const declaredEndpoints = adapter.relative_endpoints ?? {};
    assert.ok(
      entry.declaredEndpointKeys.length > 0,
      `${familyAdapterId} 已就绪，必须声明它用到哪几个适配器 endpoint 键`,
    );

    // ① 注册表声明的每个 endpoint 键在适配器里必须真实存在（键名漂移即红）。
    const expectedPaths = new Set<string>();
    for (const endpointKey of entry.declaredEndpointKeys) {
      const path = declaredEndpoints[endpointKey];
      assert.ok(
        typeof path === 'string' && path.length > 0,
        `${familyAdapterId} 的 endpoint 键「${endpointKey}」未在适配器 relative_endpoints 中声明`,
      );
      expectedPaths.add(path);
    }

    // ② 模板内出现的 endpoint 字面量必须恰好落在适配器声明的路径集合内。
    //    「素材位全开」形态覆盖条件分支的两侧（openai-image 的 edits/generations），
    //    「素材位全关」形态覆盖纯文生静态分支。
    const templateEndpoints = new Set<string>();
    for (const acceptedMediaSlots of [entry.supportsMediaSlots, [] as const]) {
      const sources = entry.buildBaseSources('consistency-check-model', { acceptedMediaSlots: [...acceptedMediaSlots] });
      for (const endpoint of collectTemplateEndpoints(sources)) templateEndpoints.add(endpoint);
    }
    assert.deepEqual(
      [...templateEndpoints].sort(),
      [...expectedPaths].sort(),
      `${familyAdapterId}: 模板内 endpoint 集合必须与适配器声明的路径集合一致`,
    );
  }
  assert.ok(readyCount > 0, '至少有一个族必须已就绪（openai-image-v1）');
});

void test('openai-image-v1：题材位开关决定走 generations 还是 edits 分支', () => {
  const entry = GENERATION_FAMILY_TEMPLATE_REGISTRY['openai-image-v1'];
  assert.equal(entry.status, 'ready');
  assert.deepEqual([...entry.supportsMediaSlots], ['reference_image'], '本族模板只能表达参考图素材位');

  const adapter = ADAPTER_REGISTRY['openai-image-v1'];
  const generations = adapter.relative_endpoints?.['generations'];
  const edits = adapter.relative_endpoints?.['edits'];
  assert.ok(generations);
  assert.ok(edits);

  // 不接受素材位：静态 t2i 分支（无 image 字段可判，条件规则不能引用不存在的字段）
  const t2i = entry.buildBaseSources('consistency-check-model', { acceptedMediaSlots: [] });
  const t2iRuntime = runtimeOf(t2i);
  assert.deepEqual([...collectTemplateEndpoints(t2i)], [generations]);
  assert.equal(endpointRuleOf(t2iRuntime).kind, 'literal', 't2i 形态的 endpoint 规则必须是字面量');

  // 接受参考图：条件分支（image 非空走 edits，否则 generations）
  const i2i = entry.buildBaseSources('consistency-check-model', { acceptedMediaSlots: ['reference_image'] });
  const i2iRule = endpointRuleOf(runtimeOf(i2i));
  assert.equal(i2iRule.kind, 'when');
  assert.deepEqual(i2iRule.truthy, { kind: 'literal', value: edits }, 'edits 分支必须等于适配器 edits 路径');
  assert.deepEqual(i2iRule.falsy, { kind: 'literal', value: generations }, 'generations 分支必须等于适配器 generations 路径');
});

/** 已就绪族（逐族实现批次逐个加入；pending 断言据此派生，避免两处手写清单漂移）。 */
const READY_FAMILY_ADAPTER_IDS: readonly GenerationFamilyAdapterId[] = [
  'openai-image-v1',
  'gemini-image-interactions-v1',
  'seedance-2-0-v1',
  'veo-v1',
  'kling-text2video-v1',
  'kling-image2video-v1',
  'kling-omni-video-v1',
];

void test('pending 族：显式标记为未就绪，且能力事实为空（不允许静默落到已实现族的模板）', () => {
  const pendingIds = GENERATION_FAMILY_ADAPTER_IDS.filter(
    (familyAdapterId: GenerationFamilyAdapterId) =>
      GENERATION_FAMILY_TEMPLATE_REGISTRY[familyAdapterId].status === 'pending',
  );
  assert.deepEqual(
    [...pendingIds].sort(),
    GENERATION_FAMILY_ADAPTER_IDS.filter((id) => !READY_FAMILY_ADAPTER_IDS.includes(id)).sort(),
    `除已实现族（${READY_FAMILY_ADAPTER_IDS.join('、')}）外的其余族必须是显式 pending（逐族实现批次逐个转 ready）`,
  );

  for (const familyAdapterId of pendingIds) {
    const entry = GENERATION_FAMILY_TEMPLATE_REGISTRY[familyAdapterId];
    assert.equal(entry.status, 'pending');
    assert.ok(entry.pendingReason.length > 0, `${familyAdapterId} 的 pending 必须带内部原因码（留痕用）`);
    assert.ok('buildBaseSources' in entry === false, `${familyAdapterId} 处于 pending 时不得挂构建器`);
    assert.deepEqual([...entry.supportsMediaSlots], [], `${familyAdapterId} 模板未就绪，能表达的素材位必须是空清单`);
  }
});
