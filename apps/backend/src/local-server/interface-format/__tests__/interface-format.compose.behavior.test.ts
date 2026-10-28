import assert from 'node:assert/strict';
import test from 'node:test';

import { isObjectRecord } from '../../model-package-catalog.shared.cts';
import { composeInterfaceFormatSources } from '../compose.cts';
import { assertNoPlaceholderResidue } from '../placeholder.cts';
import presetJson from '../presets/openai-image-v1.json';
import {
  composeFormatSources,
  getInterfaceFormat,
  loadPresetFormats,
} from '../registry.cts';
import { InterfaceFormatSchema, type InterfaceFormat } from '../schema.cts';

/**
 * 接口格式实体的**行为**门禁（不依赖任何旧族构建器）。
 *
 * 历史：这些断言原本与「实体合成 vs 族构建器深相等」混在
 * `interface-format.compose.equivalence.test.ts`。旧族文件删除后，等价性由
 * `interface-format.golden.test.ts` 的 hash 接替，本文件只保留与 oracle 无关、golden 也
 * 表达不了的部分：
 * ① 实体 schema 的否定用例（缺字段 / 未知键 / 越界素材位 / 片段错配 / 旧字段残留）；
 * ② 合成入口对越界素材位的显式拒绝（不回落、不静默）；
 * ③ 合成产物可被记录级参数覆盖链消费；
 * ④ 占位符与宏的错误码（未解析占位符、未知宏、宏残留到非声明段落）；
 * ⑤ 显式 `request_strategy` 原样进入运行时。
 */

const MODEL_ID = 'declared-openai-image-behavior-test';

const loadFormat = (): InterfaceFormat => {
  const formats = loadPresetFormats();
  const format = formats.find((item) => item.format_id === 'openai-image-v1');
  assert.ok(format);
  return format;
};

void test('合成入口拒绝参数表里的提示词保留键', () => {
  const format = loadFormat();
  const schema = format.parameters.schema;
  const fields = Array.isArray(schema.fields) ? schema.fields : [];
  const poisoned: InterfaceFormat = {
    ...format,
    parameters: {
      ...format.parameters,
      schema: {
        ...schema,
        fields: [...fields, { field_key: '__prompt', component: 'text' }],
      },
    },
  };
  assert.throws(
    () => composeInterfaceFormatSources({ format: poisoned, modelId: MODEL_ID, acceptedMediaSlots: [] }),
    /interface_format_prompt_field_in_parameters/,
  );
});

void test('实体 schema 拒绝缺字段、未知键、越界素材位与片段错配', () => {
  // 合法预设必须通过：否则下面的否定用例可能只是「这份 schema 总是失败」。
  assert.equal(InterfaceFormatSchema.safeParse(presetJson).success, true);

  const { transport: _omittedTransport, ...withoutTransport } = presetJson;
  assert.equal(InterfaceFormatSchema.safeParse(withoutTransport).success, false);

  assert.equal(
    InterfaceFormatSchema.safeParse({ ...presetJson, unknown_top_level_key: true }).success,
    false,
  );
  assert.equal(
    InterfaceFormatSchema.safeParse({
      ...presetJson,
      transport: { ...presetJson.transport, unknown_transport_key: true },
    }).success,
    false,
  );
  assert.equal(
    InterfaceFormatSchema.safeParse({
      ...presetJson,
      media: { ...presetJson.media, supports: ['not_a_media_slot'], required: [], slots: {} },
    }).success,
    false,
  );
  // 素材位片段必须与 slots 一一对应（缺片段 = 该位无法上 wire，属预设缺陷）。
  assert.equal(
    InterfaceFormatSchema.safeParse({
      ...presetJson,
      composition: { ...presetJson.composition, fragments: {} },
    }).success,
    false,
  );
  // 变体引用了未声明的素材位。
  assert.equal(
    InterfaceFormatSchema.safeParse({
      ...presetJson,
      composition: {
        ...presetJson.composition,
        variants: [
          {
            when: { slots_present: ['first_frame'] },
            patch: {},
          },
        ],
      },
    }).success,
    false,
  );
});

void test('实体 schema 拒绝旧的自动推导字段与新的形状错误', () => {
  // 显式请求规则是必填：没有 payload_rules 的格式不允许「按参数表推导」。
  const { payload_rules: _omittedPayloadRules, ...transportWithoutRules } = presetJson.transport;
  assert.equal(
    InterfaceFormatSchema.safeParse({ ...presetJson, transport: transportWithoutRules }).success,
    false,
  );

  // 旧的自动推导来源字段已退场：仍然出现在预设里必须报错（strict 未知键），
  // 否则作者会以为它还生效，而合成器完全忽略它。
  assert.equal(
    InterfaceFormatSchema.safeParse({ ...presetJson, model_binding: {} }).success,
    false,
  );
  assert.equal(
    InterfaceFormatSchema.safeParse({
      ...presetJson,
      transport: {
        ...presetJson.transport,
        headers: { Accept: 'application/json' },
      },
    }).success,
    false,
  );
  assert.equal(
    InterfaceFormatSchema.safeParse({
      ...presetJson,
      transport: {
        ...presetJson.transport,
        extra_payload_rules: {},
      },
    }).success,
    false,
  );
  assert.equal(
    InterfaceFormatSchema.safeParse({
      ...presetJson,
      parameters: { ...presetJson.parameters, wire_names: { size: 'size' } },
    }).success,
    false,
  );

  // endpoint 键允许 camelCase，但不能是非法标识（数字开头）。
  assert.equal(
    InterfaceFormatSchema.safeParse({
      ...presetJson,
      transport: {
        ...presetJson.transport,
        endpoints: { ...presetJson.transport.endpoints, '1invalid': '/x' },
      },
    }).success,
    false,
  );
  assert.equal(
    InterfaceFormatSchema.safeParse({
      ...presetJson,
      transport: {
        ...presetJson.transport,
        endpoints: { ...presetJson.transport.endpoints, taskById: '/x' },
      },
    }).success,
    true,
  );

  // success_field_paths 是字符串数组；写错类型会让轮询成功判据静默丢失。
  assert.equal(
    InterfaceFormatSchema.safeParse({
      ...presetJson,
      builtin_behavior: {
        ...presetJson.builtin_behavior,
        polling_status: {
          status_paths: ['status'],
          success_values: ['ok'],
          failure_values: [],
          success_field_paths: 'data.status',
        },
      },
    }).success,
    false,
  );
  assert.equal(
    InterfaceFormatSchema.safeParse({
      ...presetJson,
      builtin_behavior: {
        ...presetJson.builtin_behavior,
        polling_status: {
          status_paths: ['status'],
          success_values: ['ok'],
          failure_values: [],
          success_field_paths: ['data.status'],
        },
      },
    }).success,
    true,
  );
});

void test('越界素材位在合成入口显式拒绝（不回落、不静默）', () => {
  const refused = composeFormatSources('openai-image-v1', MODEL_ID, {
    acceptedMediaSlots: ['first_frame'],
  });
  assert.equal(refused.kind, 'unsupported_media_slots');
  if (refused.kind !== 'unsupported_media_slots') return;
  assert.deepEqual(refused.unsupportedMediaSlots, ['first_frame']);

  assert.throws(
    () =>
      composeInterfaceFormatSources({
        format: loadFormat(),
        modelId: MODEL_ID,
        acceptedMediaSlots: ['first_frame'],
      }),
    /interface_format_media_slot_unsupported/,
  );
  assert.equal(
    composeFormatSources('unknown-format-v1', MODEL_ID, { acceptedMediaSlots: [] }).kind,
    'unknown',
  );
  assert.equal(getInterfaceFormat('unknown-format-v1').kind, 'unknown');
});

void test('合成产物可被记录级参数覆盖链消费（素材位改名与张数）', () => {
  const composed = composeInterfaceFormatSources({
    format: loadFormat(),
    modelId: MODEL_ID,
    acceptedMediaSlots: ['reference_image'],
    parameterOverrides: {
      official: [{ field_key: 'image', wire_name: 'input_image', media_max_files: 3 }],
      custom: [],
    },
  });
  assertNoPlaceholderResidue(composed);
  const runtime = composed.runtimeModel.runtime;
  assert.ok(isObjectRecord(runtime));
  const payloadRules = runtime.payload_rules;
  assert.ok(isObjectRecord(payloadRules));
  // 发出键跟随记录级改名，旧键不得残留。
  assert.equal(payloadRules['body.image'], undefined);
  assert.ok(isObjectRecord(payloadRules['body.input_image']));

  const inputPorts = composed.node.input_ports;
  assert.ok(Array.isArray(inputPorts));
  const imagePort = inputPorts.find((port) => isObjectRecord(port) && port.field_key === 'image');
  assert.ok(isObjectRecord(imagePort));
  assert.equal(imagePort.max_connections, 3);
  assert.equal(imagePort.multiple, true);
});

void test('未解析的占位符抛出可读错误码', () => {
  const broken = {
    ...presetJson,
    localization: {
      ...presetJson.localization,
      'zh-CN': {
        ...presetJson.localization['zh-CN'],
        broker: { label: '{{endpoint:unknown_endpoint}}' },
      },
    },
  };
  const format = InterfaceFormatSchema.parse(broken);
  assert.throws(
    () => composeInterfaceFormatSources({ format, modelId: MODEL_ID, acceptedMediaSlots: [] }),
    /interface_format_placeholder_unknown/,
  );
});

void test('未知宏在合成期抛错（不落成请求体字面量）', () => {
  const broken = {
    ...presetJson,
    transport: {
      ...presetJson.transport,
      payload_rules: {
        ...presetJson.transport.payload_rules,
        'body.broken': { $unknown: true },
      },
    },
  };
  const format = InterfaceFormatSchema.parse(broken);
  assert.throws(
    () => composeInterfaceFormatSources({ format, modelId: MODEL_ID, acceptedMediaSlots: [] }),
    /interface_format_macro_unknown/,
  );
});

void test('宏只允许出现在声明段落：其他段落残留宏键即抛错', () => {
  const broken = {
    ...presetJson,
    localization: {
      ...presetJson.localization,
      'zh-CN': {
        ...presetJson.localization['zh-CN'],
        broker: { $if: true, then: { label: 'x' } },
      },
    },
  };
  const format = InterfaceFormatSchema.parse(broken);
  assert.throws(
    () => composeInterfaceFormatSources({ format, modelId: MODEL_ID, acceptedMediaSlots: [] }),
    /interface_format_macro_residue/,
  );
});

void test('显式 request_strategy 原样进入运行时（缺省才按 submit 生成）', () => {
  // 请求策略只承载地址与方法；请求头/查询参数/请求体取值只有一棵规则树。
  const strategy = {
    request_stage: 'submit',
    protocol: 'http',
    endpoint: '/v1/custom',
    method: 'PUT',
  };
  const format = InterfaceFormatSchema.parse({
    ...presetJson,
    transport: { ...presetJson.transport, request_strategy: strategy },
  });
  const composed = composeInterfaceFormatSources({ format, modelId: MODEL_ID, acceptedMediaSlots: [] });
  assert.deepStrictEqual(composed.runtimeModel.request_strategy, strategy);
});
