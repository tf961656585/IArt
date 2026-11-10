// @vitest-environment node
// @spec: CLI-063
//
// `generate --prompt` 可重复（spec 45 §5.1 / CLI spec §5.4 多意图提交）。
// 走真实命令行入口的编译产物：解析层是「用户敲了什么」到「意图列表」的唯一转换点，
// 单值/多值形态与逗号不被拆分都在这里钉死。
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const parserEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-arg-parser.cjs`;

type ParsedPrompt =
  | { ok: true; request: { prompt: string | string[] } }
  | { ok: false; reason?: string; message?: string };

const parsePrompt = (argv: readonly string[]): ParsedPrompt =>
  (createRequire(import.meta.url)(parserEntry) as { parseCliArgs: (args: readonly string[]) => ParsedPrompt }).parseCliArgs(argv);

const base = ["generate", "--project", "P", "--model", "m"];

describe("parseCliArgs：generate 多意图", () => {
  it("单次 --prompt 仍传字符串（与引入意图结构前同形）", () => {
    const parsed = parsePrompt([...base, "--prompt", "一只猫"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.prompt).toBe("一只猫");
  });

  it("重复 --prompt 按出现顺序形成数组，每个提示词一个意图", () => {
    const parsed = parsePrompt([...base, "--prompt", "动作A", "--prompt", "动作B"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.prompt).toEqual(["动作A", "动作B"]);
  });

  it("提示词里的逗号不被拆分（提示词不是列表语法）", () => {
    const parsed = parsePrompt([...base, "--prompt", "一只猫, 坐在窗台上"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.prompt).toBe("一只猫, 坐在窗台上");
  });

  it("缺少 --prompt 以用法错误拒绝", () => {
    const parsed = parsePrompt(base);
    expect(parsed.ok).toBe(false);
  });
});
