// @vitest-environment node
import { describe, expect, it } from "vitest";
import { projectFamilyModel } from "./__tests__/fixtures/familyTemplateProjectionFixtures";

/**
 * openai-image 族的单节点双模式契约（Editor 侧视角）。
 *
 * 历史：本文件原钉「gpt-image-2 合并包」——`gpt-image-2-edit` 不再作为独立包，改由
 * `gpt-image-2` 单包 + `runtime.aliases` 兼容旧 id。2026-10-20 模型能力包退场、包目录删除后，
 * 同一份契约由 **openai-image 族模板**承载：素材位 `reference_image` 的有/无决定「图生图」与
 * 「文生图」两个形态，仍是「一个模型 + 双模式」。
 *
 * 消失的是旧身份兼容那一段（alias）：包退场后没有「旧包 id」需要兼容，硬留 alias 只会让一个
 * 不存在的身份永久可解析。族模板的 `aliases` 恒为空数组，本文件据此断言「无幻影别名」。
 */
describe("openai-image 族：单节点双模式（Editor 侧）", () => {
  const MODEL_ID = "editor-openai-image-merged";

  it("图生图形态具备双模式契约（payload_format_rule + 可选 image port）", () => {
    const { projection } = projectFamilyModel({
      familyAdapterId: "openai-image-v1",
      modelId: MODEL_ID,
    });

    expect(projection.capability.input_modalities).toEqual(["text", "image"]);
    expect(projection.capability.supports_reference_media).toBe(true);
    expect(projection.capability.supports_multi_image).toBe(true);

    // prompt 是保留字段（不进端口），故输入端口只剩 image
    expect(projection.ports.inputs.map((port) => port.field_key).sort()).toEqual(["image"]);
    const imagePort = projection.ports.inputs.find((port) => port.field_key === "image");
    expect(imagePort?.required).toBe(false);
    expect(imagePort?.multiple).toBe(true);

    // 双模式用 payload_format_rule 表达（与静态 payload_format 互斥）
    expect(projection.runtime?.payload_format).toBeUndefined();
    expect(projection.runtime?.payload_format_rule).toBeTruthy();
    expect(projection.runtime?.payload_format_rule?.kind).toBe("when");
  });

  it("endpoint / contentType / body.image / body.n 都是条件规则，body.model 是 model_id 字面量", () => {
    const { projection } = projectFamilyModel({
      familyAdapterId: "openai-image-v1",
      modelId: MODEL_ID,
    });
    const payloadRules = projection.runtime?.payload_rules;

    expect(payloadRules?.["api.endpoint"]?.kind).toBe("when");
    expect(payloadRules?.["api.contentType"]?.kind).toBe("when");
    expect(payloadRules?.["body.image"]?.kind).toBe("when");
    expect(payloadRules?.["body.n"]?.kind).toBe("when");

    // 输出格式走官方字段 output_format（t2i 与 edits 两条路径都透传），旧 body.format 不得回流
    expect(payloadRules?.["body.format"]).toBeUndefined();
    expect(payloadRules?.["body.output_format"]).toMatchObject({
      kind: "field",
      field_key: "format",
    });

    // model 字面量是声明传入的 model_id（remote_model_id 注入点的占位身份）
    expect(payloadRules?.["body.model"]).toMatchObject({
      kind: "literal",
      value: MODEL_ID,
    });

    // api_defaults 保留 generations 作为 fallback 形态
    expect(projection.runtime?.api_defaults).toMatchObject({
      endpoint: "/v1/images/generations",
      method: "POST",
      contentType: "application/json",
    });

    // 图生图走 multipart_file 直传，不用公网中转
    expect(projection.runtime?.url_input_upload_mode).toBeUndefined();
    expect(projection.runtime?.url_input_upload_target_type).toBeUndefined();
  });

  it("没有幻影别名：族模板不声明任何 alias（旧包 id 不该继续可解析）", () => {
    const { projection } = projectFamilyModel({
      familyAdapterId: "openai-image-v1",
      modelId: MODEL_ID,
    });
    expect(projection.runtime?.aliases ?? []).toEqual([]);
  });

  it("文生图形态（不接受参考图）：静态 json、无 image 字段与端口", () => {
    const { projection } = projectFamilyModel({
      familyAdapterId: "openai-image-v1",
      modelId: MODEL_ID,
      acceptedMediaSlots: [],
    });
    expect(projection.runtime?.payload_format).toBe("json");
    expect(projection.runtime?.payload_format_rule).toBeUndefined();
    expect(projection.ports.inputs.map((port) => port.field_key)).toEqual([]);
    expect(
      projection.parameter_schema.fields.some((field) => field.field_key === "image"),
    ).toBe(false);
  });
});
