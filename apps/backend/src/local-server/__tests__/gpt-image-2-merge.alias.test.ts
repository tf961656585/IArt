import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";

import { findProjectionByModelIdOrAlias } from "../model-package-catalog.cts";

// 从测试文件位置向上导航到仓库根的 .model-assets/packages。
// 测试文件在 apps/backend/src/local-server/__tests__/，需要向上 5 级到项目根。
const REPO_PACKAGES_DIR = path.resolve(
  __dirname,
  "..", "..", "..", "..", "..",
  ".model-assets", "packages",
);

void describe("gpt-image-2 merged package: alias resolution", () => {
  const previousPackageRoot = process.env["IART_MODEL_ASSET_PACKAGES_DIR"];

  void it("finds projection by model_id gpt-image-2", () => {
    process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = REPO_PACKAGES_DIR;
    try {
      const result = findProjectionByModelIdOrAlias("gpt-image-2");
      assert.ok(result, "should find gpt-image-2 by model_id");
      assert.equal(result.projection.model_id, "gpt-image-2");
    } finally {
      if (previousPackageRoot !== undefined) {
        process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previousPackageRoot;
      } else {
        delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
      }
    }
  });

  void it("finds projection by alias gpt-image-2-edit (合并后 alias 兼容)", () => {
    process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = REPO_PACKAGES_DIR;
    try {
      const result = findProjectionByModelIdOrAlias("gpt-image-2-edit");
      assert.ok(result, "should find gpt-image-2 via alias gpt-image-2-edit");
      assert.equal(result.projection.model_id, "gpt-image-2");
      const aliases = result.projection.runtime.aliases;
      assert.ok(Array.isArray(aliases) && aliases.includes("gpt-image-2-edit"),
        `aliases should include gpt-image-2-edit, got: ${JSON.stringify(aliases)}`);
    } finally {
      if (previousPackageRoot !== undefined) {
        process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previousPackageRoot;
      } else {
        delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
      }
    }
  });

  void it("合并包包含可选 image 端口和 payload_format_rule", () => {
    process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = REPO_PACKAGES_DIR;
    try {
      const result = findProjectionByModelIdOrAlias("gpt-image-2");
      assert.ok(result);
      const ports = result.projection.ports;
      const imagePort = ports.inputs.find((p: { id: string }) => p.id === "image");
      assert.ok(imagePort, "合并包必须有 image 端口");
      assert.equal(imagePort.required, false, "image 端口必须可选（required=false）");
      assert.equal(imagePort.multiple, true, "image 端口必须支持多图（multiple=true）");

      const runtime = result.projection.runtime;
      assert.ok(runtime.payload_format_rule, "合并包必须有 payload_format_rule");
      assert.equal(runtime.payload_format, undefined, "静态 payload_format 必须未声明（与 payload_format_rule 互斥）");
    } finally {
      if (previousPackageRoot !== undefined) {
        process.env["IART_MODEL_ASSET_PACKAGES_DIR"] = previousPackageRoot;
      } else {
        delete process.env["IART_MODEL_ASSET_PACKAGES_DIR"];
      }
    }
  });
});
