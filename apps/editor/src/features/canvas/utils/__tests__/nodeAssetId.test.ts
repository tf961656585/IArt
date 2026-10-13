import { describe, expect, it } from "vitest";

import { readNodeAssetId } from "../nodeAssetId";

/**
 * 「复制素材 ID」触发条件判据（spec：画布对象右键菜单.md §7.1 / @spec: CM-030）。
 * 节点对象用最小结构传入（readNodeAssetId 只消费 type + data）。
 */

const withData = (type: string, data: unknown) => ({ type, data });

describe("readNodeAssetId", () => {
  // @spec: CM-030
  it("四类持有素材 id 的节点返回 assetId", () => {
    expect(readNodeAssetId(withData("imageInput", { assetId: "a1b2c3d4e5f60718" }))).toBe(
      "a1b2c3d4e5f60718",
    );
    expect(readNodeAssetId(withData("videoInput", { assetId: "a1b2c3d4e5f60718" }))).toBe(
      "a1b2c3d4e5f60718",
    );
    expect(readNodeAssetId(withData("audioInput", { assetId: "a1b2c3d4e5f60718" }))).toBe(
      "a1b2c3d4e5f60718",
    );
    expect(readNodeAssetId(withData("asset", { assetId: "a1b2c3d4e5f60718" }))).toBe(
      "a1b2c3d4e5f60718",
    );
  });

  // @spec: CM-030
  it("空内容素材节点（assetId 空）返回 null", () => {
    expect(readNodeAssetId(withData("imageInput", { assetId: undefined }))).toBeNull();
    expect(readNodeAssetId(withData("imageInput", { assetId: null }))).toBeNull();
    expect(readNodeAssetId(withData("imageInput", { assetId: "" }))).toBeNull();
    expect(readNodeAssetId(withData("imageInput", {}))).toBeNull();
  });

  // @spec: CM-030
  it("任务/文本素材/组/Agent 节点不持有素材 id 身份，即使 data 含同名字段", () => {
    expect(readNodeAssetId(withData("task", { assetId: "a1b2c3d4e5f60718" }))).toBeNull();
    expect(readNodeAssetId(withData("textInput", { assetId: "a1b2c3d4e5f60718" }))).toBeNull();
    expect(readNodeAssetId(withData("group", { assetId: "a1b2c3d4e5f60718" }))).toBeNull();
    expect(readNodeAssetId(withData("agent", { assetId: "a1b2c3d4e5f60718" }))).toBeNull();
  });

  it("非字符串 assetId 与空入参返回 null", () => {
    expect(readNodeAssetId(withData("imageInput", { assetId: 42 }))).toBeNull();
    expect(readNodeAssetId(null)).toBeNull();
    expect(readNodeAssetId(undefined)).toBeNull();
  });
});
