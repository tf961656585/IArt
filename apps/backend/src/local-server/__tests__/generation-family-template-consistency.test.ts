import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloneJsonValue,
  GENERATION_FAMILY_ADAPTER_IDS,
  type GenerationFamilyAdapterId,
} from '@iart/contracts';
import { isObjectRecord } from '../model-package-catalog.shared.cts';
import {
  GENERATION_FAMILY_TEMPLATE_REGISTRY,
  getFamilyTemplate,
  requireFamilyTemplate,
} from '../generation-family-templates.registry.cts';
import { getInterfaceFormat } from '../interface-format/registry.cts';
import { isMediaSlotComponentName } from '../generation-parameter-overrides.cts';
import type { GenerationFamilyTemplateSources } from '../generation-family-templates.cts';
import type { JsonObject } from '../model-package-catalog.types.cts';

/**
 * 族模板注册表 ↔ 适配器一致性门禁（docs/custom-providers/生成模型自建声明试点-design.md §3.4，
 * D3：模板内置 endpoint + 与适配器声明的一致性门禁）。
 *
 * 2026-10-19 起接口类型由 1 个扩到 7 个（2026-10-24 加入 openai-video-v1 后为 8 个），
 * 本门禁同步逐族化，钉三件事：
 * ① **注册表 7 键齐全**：键集必须与 contracts 的 `GENERATION_FAMILY_ADAPTER_IDS`（值域唯一
 *    owner）逐一对应。注册表类型已是 `Record<GenerationFamilyAdapterId, ...>`，少键在编译期
 *    就红；这里再钉一次是因为 `as const` 数组与 `Record` 的键集可能被同时删一格——两边一起
 *    改会让编译期保障失效，只有运行时比对能发现。
 * ② **ready 族的 endpoint 自洽**：2026-10-27 生成侧代码适配器退场后，endpoint 事实源只剩
 *    接口格式实体的 `transport.endpoints`。本测试把模板内所有 endpoint 分支收集起来，与
 *    格式声明的 endpoint 路径集合双向对齐——模板不得引用未声明路径，声明的每个 endpoint
 *    也必须在模板里真实出现。任一侧漂移即红（原「模板 ↔ 适配器」双事实源门禁的单源形态）。
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
 * `runtime.payload_rules['api.endpoint']`）、**轮询查询端点**
 * （`runtimeModel.polling_strategy.request.url_template`）与**结果获取端点**
 * （`runtimeModel.result_acquisition_strategy.request_strategy.endpoint`）。异步族的两个
 * endpoint 键（seedance 的 `tasks` / `taskById`）分别落在前两类位置上；带内置 `needs_fetch`
 * 获取策略的族（openai-video 的 `videoContent`）把第三个端点落在获取段落里——只看前两类的话，
 * 获取端点永远落在「模板未使用」这一侧，门禁就只能靠注册表自述，失去双向核对的意义。
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
  const acquisitionStrategy = sources.runtimeModel['result_acquisition_strategy'];
  if (isObjectRecord(acquisitionStrategy)) {
    const acquisitionRequest = acquisitionStrategy['request_strategy'];
    if (isObjectRecord(acquisitionRequest)) readEndpoint(acquisitionRequest['endpoint']);
  }
  return endpoints;
};

void test('注册表键集 ≡ contracts 的 GENERATION_FAMILY_ADAPTER_IDS（8 族齐全，防两处漂移）', () => {
  const registryKeys = Object.keys(GENERATION_FAMILY_TEMPLATE_REGISTRY).sort();
  const contractIds = [...GENERATION_FAMILY_ADAPTER_IDS].sort();
  assert.deepEqual(registryKeys, contractIds, '族模板注册表必须与契约接口类型值域逐一对应');
  assert.equal(registryKeys.length, 8, '2026-10-24 起接口类型共 8 个');

  // 每个条目的 familyAdapterId 必须与自己的键一致（防止复制粘贴条目时漏改内部字段）
  for (const id of GENERATION_FAMILY_ADAPTER_IDS) {
    assert.equal(requireFamilyTemplate(id).familyAdapterId, id, `${id} 条目内部 id 必须与键一致`);
    assert.ok(getFamilyTemplate(id) !== null, `${id} 必须能按 id 取到注册条目`);
  }
  // 未知 id（已删掉的旧 id / 拼写错误）必须返回 null，而不是命中某个默认条目
  assert.equal(getFamilyTemplate('kling-v1'), null);
  assert.equal(getFamilyTemplate('not-a-family'), null);
});

void test('ready 族：模板 endpoint 与接口格式声明的端点集合双向一致', () => {
  let readyCount = 0;
  for (const familyAdapterId of GENERATION_FAMILY_ADAPTER_IDS) {
    const entry = requireFamilyTemplate(familyAdapterId);
    if (entry.status !== 'ready') continue;
    readyCount += 1;

    const lookup = getInterfaceFormat(familyAdapterId);
    assert.equal(lookup.kind, 'ready', `${familyAdapterId} 必须能作为接口格式实体解析`);
    if (lookup.kind !== 'ready') continue;
    const declaredPaths = new Set(Object.values(lookup.format.transport.endpoints));
    assert.ok(
      declaredPaths.size > 0,
      `${familyAdapterId} 已就绪，必须声明它用到哪几个 endpoint 路径`,
    );
    assert.deepEqual(
      [...entry.declaredEndpointKeys].sort(),
      Object.keys(lookup.format.transport.endpoints).sort(),
      `${familyAdapterId} 的 endpoint 键集必须与格式声明一致`,
    );

    // 模板内出现的 endpoint 字面量必须恰好落在格式声明的路径集合内。
    // 「素材位全开」形态覆盖条件分支的两侧（openai-image 的 edits/generations），
    // 「素材位全关」形态覆盖纯文生静态分支。
    const templateEndpoints = new Set<string>();
    for (const acceptedMediaSlots of [entry.supportsMediaSlots, [] as const]) {
      const sources = entry.buildBaseSources('consistency-check-model', { acceptedMediaSlots: [...acceptedMediaSlots] });
      for (const endpoint of collectTemplateEndpoints(sources)) templateEndpoints.add(endpoint);
    }
    assert.deepEqual(
      [...templateEndpoints].sort(),
      [...declaredPaths].sort(),
      `${familyAdapterId}: 模板内 endpoint 集合必须与格式声明的路径集合一致`,
    );
  }
  assert.ok(readyCount > 0, '至少有一个族必须已就绪（openai-image-v1）');
});

void test('openai-image-v1：题材位开关决定走 generations 还是 edits 分支', () => {
  const entry = requireFamilyTemplate('openai-image-v1');
  assert.equal(entry.status, 'ready');
  assert.deepEqual([...entry.supportsMediaSlots], ['reference_image'], '本族模板只能表达参考图素材位');

  const lookup = getInterfaceFormat('openai-image-v1');
  assert.equal(lookup.kind, 'ready');
  if (lookup.kind !== 'ready') return;
  const generations = lookup.format.transport.endpoints['generations'];
  const edits = lookup.format.transport.endpoints['edits'];
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
  assert.deepEqual(i2iRule.truthy, { kind: 'literal', value: edits }, 'edits 分支必须等于格式声明的 edits 路径');
  assert.deepEqual(i2iRule.falsy, { kind: 'literal', value: generations }, 'generations 分支必须等于格式声明的 generations 路径');
});

/** 已就绪族（逐族实现批次逐个加入；pending 断言据此派生，避免两处手写清单漂移）。 */
const READY_FAMILY_ADAPTER_IDS: readonly GenerationFamilyAdapterId[] = [
  'openai-image-v1',
  'openai-video-v1',
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
      requireFamilyTemplate(familyAdapterId).status === 'pending',
  );
  assert.deepEqual(
    [...pendingIds].sort(),
    GENERATION_FAMILY_ADAPTER_IDS.filter((id) => !READY_FAMILY_ADAPTER_IDS.includes(id)).sort(),
    `除已实现族（${READY_FAMILY_ADAPTER_IDS.join('、')}）外的其余族必须是显式 pending（逐族实现批次逐个转 ready）`,
  );

  for (const familyAdapterId of pendingIds) {
    const entry = requireFamilyTemplate(familyAdapterId);
    assert.equal(entry.status, 'pending');
    assert.ok(entry.pendingReason.length > 0, `${familyAdapterId} 的 pending 必须带内部原因码（留痕用）`);
    assert.ok('buildBaseSources' in entry === false, `${familyAdapterId} 处于 pending 时不得挂构建器`);
    assert.deepEqual([...entry.supportsMediaSlots], [], `${familyAdapterId} 模板未就绪，能表达的素材位必须是空清单`);
  }
});

// ---------------------------------------------------------------------------
// 显示设置一致性（2026-10-26，设计 §3.5.1「缺显示设置时的读取降级与保存拦截」）
// ---------------------------------------------------------------------------

/**
 * 需要显示设置（`component_props`）的两类字段：素材输入组件与画幅组件。
 *
 * 判定不另列清单：素材位组件名走覆盖校验的同一份集合（`isMediaSlotComponentName`），画幅
 * 组件名 `imageSize` 是参数覆盖开放「档位/比例收窄」的唯一组件类型。参数覆盖的写入只读这两类
 * 字段的显示设置，缺了它们写入只能被降级跳过（否则整份投影抛错）。
 */
const collectFieldsMissingComponentProps = (sources: GenerationFamilyTemplateSources): string[] => {
  const parameterSchema = sources.runtimeModel.parameter_schema;
  if (!isObjectRecord(parameterSchema) || !Array.isArray(parameterSchema.fields)) return [];
  const missing: string[] = [];
  for (const rawField of parameterSchema.fields) {
    if (!isObjectRecord(rawField)) continue;
    const component = typeof rawField.component === 'string' ? rawField.component.toLowerCase() : '';
    if (!isMediaSlotComponentName(component) && component !== 'imagesize') continue;
    if (!isObjectRecord(rawField.component_props)) {
      const fieldKey = typeof rawField.field_key === 'string' ? rawField.field_key : '<no-field-key>';
      missing.push(`${fieldKey}:${component}`);
    }
  }
  return missing;
};

void test('ready 族：素材位与画幅字段必须带 component_props（缺显示设置只能由内置模板产生）', () => {
  let readyCount = 0;
  for (const familyAdapterId of GENERATION_FAMILY_ADAPTER_IDS) {
    const entry = requireFamilyTemplate(familyAdapterId);
    if (entry.status !== 'ready') continue;
    readyCount += 1;
    // 两种形态都要看：素材位全开覆盖「有该位的族」，空清单覆盖「文生基线」。
    for (const acceptedMediaSlots of [entry.supportsMediaSlots, [] as const]) {
      const sources = entry.buildBaseSources('display-settings-check-model', {
        acceptedMediaSlots: [...acceptedMediaSlots],
      });
      assert.deepEqual(
        collectFieldsMissingComponentProps(sources),
        [],
        `${familyAdapterId}：素材位与画幅字段必须带 component_props 对象——缺了它，参数覆盖的张数/档位写入只能被降级跳过（用户设的值静默不生效）`,
      );
    }
  }
  assert.ok(readyCount > 0, '至少有一个族必须已就绪');
});

void test('显示设置检查器本身有牙：抽掉 component_props 立刻点名（防守卫空转）', () => {
  const entry = requireFamilyTemplate('openai-image-v1');
  assert.equal(entry.status, 'ready');
  const sources = entry.buildBaseSources('display-settings-check-model', {
    acceptedMediaSlots: ['reference_image'],
  });
  const runtimeModel = cloneJsonValue(sources.runtimeModel);
  const parameterSchema = runtimeModel.parameter_schema;
  assert.ok(isObjectRecord(parameterSchema) && Array.isArray(parameterSchema.fields));
  parameterSchema.fields = parameterSchema.fields.map((rawField) => {
    if (!isObjectRecord(rawField) || rawField.field_key !== 'image') return rawField;
    const stripped: JsonObject = {};
    for (const [key, value] of Object.entries(rawField)) {
      if (key === 'component_props') continue;
      stripped[key] = value;
    }
    return stripped;
  });
  assert.deepEqual(
    collectFieldsMissingComponentProps({ ...sources, runtimeModel }),
    ['image:imageupload'],
    '检查器必须点名缺显示设置的字段（否则门禁全绿也拦不住模板漂移）',
  );
});
