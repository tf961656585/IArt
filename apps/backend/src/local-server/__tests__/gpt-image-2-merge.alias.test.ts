import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GenerationMediaSlotId } from "@iart/contracts";
import {
  OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID,
  OPENAI_IMAGE_V1_SUPPORTED_MEDIA_SLOTS,
  buildOpenAiImageV1BaseTemplateSources,
} from "../generation-family-templates.openai-image.cts";
import { projectFamilyTemplate } from "./family-template-projection-test-helpers";

/**
 * openai-image 族的「文生图 / 图生图合并成单节点」契约。
 *
 * 历史：这组断言原本钉在真实包 `gpt-image-2`（由 `gpt-image-2` + `gpt-image-2-edit` 合并而
 * 来，edit 身份以 alias 兼容）。2026-10-20 模型能力包退场、包目录删除后，同样的契约由
 * **openai-image 族模板**承载——它接受的素材位里就有 `reference_image`，有/无该素材位分别
 * 对应图生图与文生图两个形态，仍然是「一个节点双模式」。
 *
 * 断言仍走真实投影管线（`buildProjectionFromPackageSources`）：包退了，管线在，且它现在是
 * 自建生成模型进目录的唯一通道。
 */

const MODEL_ID = "declared-openai-image-merge-test";

const projectMerged = (acceptedMediaSlots: readonly GenerationMediaSlotId[]) =>
  projectFamilyTemplate({
    familyAdapterId: OPENAI_IMAGE_V1_FAMILY_ADAPTER_ID,
    buildBaseSources: buildOpenAiImageV1BaseTemplateSources,
    supportsMediaSlots: OPENAI_IMAGE_V1_SUPPORTED_MEDIA_SLOTS,
    acceptedMediaSlots,
    modelId: MODEL_ID,
  }).projection;

void describe("openai-image 族：单节点双模式（文生图 / 图生图）契约", () => {
  void it("图生图形态：image 端口可选且支持多图", () => {
    const projection = projectMerged(["reference_image"]);
    assert.equal(projection.model_id, MODEL_ID);

    const imagePort = projection.ports.inputs.find((port) => port.id === "image");
    assert.ok(imagePort, "含参考图的形态必须有 image 端口");
    assert.equal(imagePort.required, false, "image 端口必须可选（required=false）");
    assert.equal(imagePort.multiple, true, "image 端口必须支持多图（multiple=true）");
  });

  void it("图生图形态：payload_format_rule 在 json 与 multipart 之间切换，静态 payload_format 未声明", () => {
    const projection = projectMerged(["reference_image"]);
    const runtime = projection.runtime;
    assert.ok(runtime.payload_format_rule, "含参考图的形态必须有 payload_format_rule");
    assert.equal(
      runtime.payload_format,
      undefined,
      "静态 payload_format 必须未声明（与 payload_format_rule 互斥）",
    );
  });

  void it("文生图形态：无 image 字段与端口，payload_format 静态 json", () => {
    const projection = projectMerged([]);
    assert.equal(projection.model_id, MODEL_ID);
    assert.equal(
      projection.ports.inputs.some((port) => port.id === "image"),
      false,
      "不接受参考图时不得出现 image 端口（引用不存在的字段会被投影校验拦下）",
    );
    assert.equal(
      projection.parameter_schema.fields.some((field) => field.field_key === "image"),
      false,
      "不接受参考图时不得出现 image 表单字段",
    );
    assert.equal(projection.runtime.payload_format, "json");
    assert.equal(
      projection.runtime.payload_format_rule,
      undefined,
      "静态 payload_format 形态不得同时声明 payload_format_rule",
    );
  });

  void it("两形态共用同一 model_id 与虚拟包身份（合并语义：不再是两个独立模型）", () => {
    const withReference = projectMerged(["reference_image"]);
    const textOnly = projectMerged([]);
    assert.equal(withReference.model_id, textOnly.model_id);
    assert.equal(withReference.package_id, textOnly.package_id);
  });
});
