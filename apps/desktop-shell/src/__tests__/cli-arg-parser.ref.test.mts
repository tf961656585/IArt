// @vitest-environment node
// @spec: CLI-014
//
// `generate --ref <素材标识>[:<用途>]` 的参数解析（spec §5.4 引用用途）。
// 从 cli-client.test.mts 拆出：该文件已到行数预算边界；本文件只承载引用用途语法与形状校验。
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const parserEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-arg-parser.cjs`;

type ParserModule = {
  parseCliArgs: (argv: readonly string[]) =>
    | { ok: true; request: { ref?: { asset_id: string; slot_id: string | null }[] }; json: boolean }
    | { ok: false; reason?: string; message?: string; topic?: { kind: string } };
};

const parse = (argv: readonly string[]) =>
  (requireDesktop(parserEntry) as ParserModule).parseCliArgs(argv);

describe("parseCliArgs：generate --ref 参考用途", () => {
  it("--ref <素材标识>:<用途> 拆分用途，可与不带用途的条目混写", () => {
    const parsed = parse([
      "generate",
      "--project",
      "P",
      "--prompt",
      "T",
      "--model",
      "M",
      "--ref",
      "a:first_frame,b",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request.ref).toEqual([
      { asset_id: "a", slot_id: "first_frame" },
      { asset_id: "b", slot_id: null },
    ]);
  });

  it("不带用途时 slot_id 落 null（由提交侧按设计 §8 兜底），不是缺键", () => {
    const parsed = parse([
      "generate",
      "--project",
      "P",
      "--prompt",
      "T",
      "--model",
      "M",
      "--ref",
      "a,b",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request.ref).toEqual([
      { asset_id: "a", slot_id: null },
      { asset_id: "b", slot_id: null },
    ]);
  });

  it("空素材标识 / 空用途标识在解析期报参数错误", () => {
    const emptyAsset = parse([
      "generate",
      "--project",
      "P",
      "--prompt",
      "T",
      "--model",
      "M",
      "--ref",
      ":first_frame",
    ]);
    expect(emptyAsset.ok).toBe(false);
    if (emptyAsset.ok) throw new Error("unreachable");
    expect(emptyAsset.reason === "usage-error" ? emptyAsset.message : "").toContain(
      "素材标识不能为空",
    );

    const emptySlot = parse([
      "generate",
      "--project",
      "P",
      "--prompt",
      "T",
      "--model",
      "M",
      "--ref",
      "a:",
    ]);
    expect(emptySlot.ok).toBe(false);
    if (emptySlot.ok) throw new Error("unreachable");
    expect(emptySlot.reason === "usage-error" ? emptySlot.message : "").toContain(
      "用途标识不能为空",
    );
  });
});
