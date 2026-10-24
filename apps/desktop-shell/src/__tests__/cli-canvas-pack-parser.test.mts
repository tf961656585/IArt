// @vitest-environment node
// @spec: CLI-055
//
// CLI 解析器 · `canvas layout --pack / --gap / --columns` 组合解析（spec §5.3 / CLI-055）。
//
// 从 cli-client.test.mts 拆出（该文件已超出 max-lines 预算，本批不再加深）。
// 组合合法性（--pack 仅 containers、--gap 只与 --pack 同用）由执行侧 `command_rejected`
// 裁定，解析器只做形状与取值域校验。

import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const parserEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-arg-parser.cjs`;

type ParserModule = {
  parseCliArgs: (argv: readonly string[]) =>
    | { ok: true; request: unknown; json: boolean }
    | { ok: false; reason?: string; message?: string; topic?: { kind: string } };
};

const parser = requireDesktop(parserEntry) as ParserModule;

describe("canvas layout --pack 解析（CLI-055）", () => {
  it("--pack / --gap / --columns 组合：布尔与间距数值原样进请求", () => {
    const packed = parser.parseCliArgs([
      "canvas", "layout", "--project", "P", "--scope", "containers",
      "--pack", "--gap", "0", "--columns", "3", "--order", "g2,g1",
    ]);
    expect(packed.ok).toBe(true);
    if (!packed.ok) throw new Error("unreachable");
    expect(packed.request).toEqual({
      command: "canvas.layout",
      project: "P",
      scope: "containers",
      columns: 3,
      order: ["g2", "g1"],
      gap: 0,
      pack: true,
    });
  });

  it("缺省不带 pack/gap；--gap 单独出现照常解析（组合拒绝归执行侧）", () => {
    const bare = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--scope", "containers"]);
    expect(bare.ok).toBe(true);
    if (!bare.ok) throw new Error("unreachable");
    expect(bare.request).not.toHaveProperty("pack");
    expect(bare.request).not.toHaveProperty("gap");

    const gapOnly = parser.parseCliArgs([
      "canvas", "layout", "--project", "P", "--scope", "containers", "--gap", "40",
    ]);
    expect(gapOnly.ok).toBe(true);
    if (!gapOnly.ok) throw new Error("unreachable");
    expect(gapOnly.request).toMatchObject({ command: "canvas.layout", gap: 40 });
  });

  it("--gap 非负整数：负数 / 小数 / 非数字是用法错误", () => {
    for (const badGap of ["-1", "1.5", "abc"]) {
      const rejected = parser.parseCliArgs([
        "canvas", "layout", "--project", "P", "--scope", "containers", "--pack", "--gap", badGap,
      ]);
      expect(rejected.ok, badGap).toBe(false);
    }
  });
});
