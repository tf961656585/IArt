// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as runtimeFixtures from "./__tests__/fixtures/runtimeModelSelectionRealPackagesFixtures";

/**
 * gpt-image-2 单节点双模式 + alias 兼容测试
 *
 * 合并改造后：
 * - `gpt-image-2-edit` 不再作为独立包存在。
 * - `gpt-image-2` 单包承载双模式：不连图 = 文生图（JSON /v1/images/generations），
 *   连图 = 图生图（multipart /v1/images/edits）。
 * - 通过 `runtime.aliases: ["gpt-image-2-edit"]` 让旧 model_id 继续命中合并包。
 *
 * 本测试替代旧"gpt-image-2-edit 独立包"测试，验证合并后的契约。
 * 旧的 gpt-image-2-edit 独立包断言已废弃——它是合并前的设计快照。
 */
describe("runtimeModelSelection.gpt-image-2-edit.real-packages", () => {
  it("gpt-image-2-edit 不再作为独立 model_id 存在（已合并入 gpt-image-2）", () => {
    const projections = runtimeFixtures.loadPackageProjections();
    const editIndependent = projections.find(
      (item) => item.model_id === "gpt-image-2-edit",
    );
    // 合并后 gpt-image-2-edit 不应是独立 projection
    expect(editIndependent).toBeUndefined();
  });

  it("gpt-image-2 合并包具备双模式契约（payload_format_rule + 可选 image port + alias）", () => {
    const projections = runtimeFixtures.loadPackageProjections();
    const merged = projections.find((item) => item.model_id === "gpt-image-2");
    expect(merged).toBeTruthy();

    // 合并包必须有可选 image 端口（required=false, multiple=true）。
    // prompt 已从 input_ports 剥离（方案 B），不再作为端口暴露，故输入端口只剩 image。
    expect(merged?.capability.input_modalities).toEqual(["text", "image"]);
    expect(merged?.capability.supports_reference_media).toBe(true);
    expect(merged?.capability.supports_multi_image).toBe(true);
    expect(merged?.ports.inputs.map((port) => port.field_key).sort()).toEqual([
      "image",
    ]);
    const imagePort = merged?.ports.inputs.find((p) => p.field_key === "image");
    expect(imagePort?.required).toBe(false);
    expect(imagePort?.multiple).toBe(true);

    // 合并包使用 payload_format_rule（与静态 payload_format 互斥）
    expect(merged?.runtime?.payload_format).toBeUndefined();
    expect(merged?.runtime?.payload_format_rule).toBeTruthy();
    expect(merged?.runtime?.payload_format_rule?.kind).toBe("when");

    // 合并包声明 alias gpt-image-2-edit
    expect(merged?.runtime?.aliases).toContain("gpt-image-2-edit");

    // endpoint / contentType / body.image / body.n 都是 when 规则
    expect(merged?.runtime?.payload_rules?.["api.endpoint"]?.kind).toBe("when");
    expect(merged?.runtime?.payload_rules?.["api.contentType"]?.kind).toBe("when");
    expect(merged?.runtime?.payload_rules?.["body.image"]?.kind).toBe("when");
    expect(merged?.runtime?.payload_rules?.["body.n"]?.kind).toBe("when");

    // 输出格式走官方字段 output_format（t2i JSON 与 edits multipart 两条路径都透传），
    // 旧 body.format when 规则（有图时置 null）已移除。
    expect(merged?.runtime?.payload_rules?.["body.format"]).toBeUndefined();
    expect(merged?.runtime?.payload_rules?.["body.output_format"]).toMatchObject({
      kind: "field",
      field_key: "format",
    });

    // body.model 仍是 literal "gpt-image-2"（远端模型 ID 不变）
    expect(merged?.runtime?.payload_rules?.["body.model"]).toMatchObject({
      kind: "literal",
      value: "gpt-image-2",
    });

    // api.defaults.endpoint 保留 generations 作为 fallback
    expect(merged?.runtime?.api_defaults).toMatchObject({
      endpoint: "/v1/images/generations",
      method: "POST",
      contentType: "application/json",
    });

    // 合并包不使用 public_relay（图生图走 multipart_file 直传）
    expect(merged?.runtime?.url_input_upload_mode).toBeUndefined();
    expect(merged?.runtime?.url_input_upload_target_type).toBeUndefined();
  });
});
