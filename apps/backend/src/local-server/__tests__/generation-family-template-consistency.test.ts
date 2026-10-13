import assert from 'node:assert/strict';
import test from 'node:test';

import { ADAPTER_REGISTRY } from '@iart/contracts';
import {
  buildOpenAiImageV1TemplateSources,
  OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID,
} from '../generation-family-templates.cts';

/**
 * 族模板 ↔ 适配器一致性门禁（docs/custom-providers/生成模型自建声明试点-design.md §3.4，
 * D3：试点形态 = 模板内置 endpoint + 与适配器声明的一致性门禁）。
 *
 * endpoint 事实源在试点期有两个落点：执行链消费模板 `api_defaults` / payload_rules（包内
 * 值域），登记真相在 `packages/contracts` ADAPTER_REGISTRY 的 `relative_endpoints`。本测试
 * 把两者钉死：任一侧漂移即红，防止「模板改了端点、适配器没跟上」的静默分叉（PC-02 遗留的
 * 双事实源在试点期的收口形态）。
 */

const adapter = ADAPTER_REGISTRY[OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID];
assert.ok(adapter, 'openai-image-v1 adapter must be registered in ADAPTER_REGISTRY');

void test('族模板 endpoint ≡ 适配器 relative_endpoints（generations 与 edits 两分支）', () => {
  const endpoints = adapter.relative_endpoints ?? {};
  const generationsEndpoint = endpoints['generations'];
  const editsEndpoint = endpoints['edits'];
  assert.ok(generationsEndpoint, 'adapter must declare the generations endpoint');
  assert.ok(editsEndpoint, 'adapter must declare the edits endpoint');

  for (const supportsReferenceImage of [false, true]) {
    const sources = buildOpenAiImageV1TemplateSources('consistency-check-model', {
      supportsReferenceImage,
    });
    const runtime = sources.runtimeModel.runtime as {
      api_defaults: { endpoint: unknown; method: unknown };
      payload_rules: Record<
        string,
        { kind: string; value?: unknown; truthy?: { value: unknown }; falsy?: { value: unknown } }
      >;
    };

    // api_defaults.endpoint（执行链消费的提交端点）≡ 适配器 generations 路径。
    assert.equal(
      runtime.api_defaults.endpoint,
      generationsEndpoint,
      'template api_defaults.endpoint must equal the adapter generations endpoint',
    );

    // request_strategy.endpoint（提交阶段声明）同口径。
    const requestStrategy = sources.runtimeModel.request_strategy as { endpoint: unknown };
    assert.equal(requestStrategy.endpoint, generationsEndpoint);

    // edits 分支（i2i 形态 payload_rules api.endpoint 的 truthy 分支）≡ 适配器 edits 路径。
    const apiEndpointRule = runtime.payload_rules['api.endpoint'];
    assert.ok(apiEndpointRule, 'i2i-capable template must declare the conditional api.endpoint rule');
    if (apiEndpointRule.kind === 'when') {
      assert.equal(
        apiEndpointRule.truthy?.value,
        editsEndpoint,
        'template edits branch must equal the adapter edits endpoint',
      );
      assert.equal(
        apiEndpointRule.falsy?.value,
        generationsEndpoint,
        'template generations branch must equal the adapter generations endpoint',
      );
    }
  }
});

void test('t2i-only 形态的静态 endpoint 同样 ≡ 适配器 generations 路径', () => {
  const endpoints = adapter.relative_endpoints ?? {};
  const generationsEndpoint = endpoints['generations'];
  assert.ok(generationsEndpoint);
  const sources = buildOpenAiImageV1TemplateSources('consistency-check-model', {
    supportsReferenceImage: false,
  });
  const runtime = sources.runtimeModel.runtime as {
    payload_rules: Record<string, { kind: string; value?: unknown }>;
  };
  const apiEndpointRule = runtime.payload_rules['api.endpoint'];
  assert.ok(apiEndpointRule);
  assert.equal(apiEndpointRule.kind, 'literal');
  assert.equal(apiEndpointRule.value, generationsEndpoint);
});
