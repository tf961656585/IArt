// @vitest-environment node
// @spec: CLI-030
//
// 批次 1b：`canvas layout --plan <路径>` 主进程入口测试。
// 覆盖计划文件读取/校验（读失败、非法 JSON、schema 不符）、与 scope 族互斥、
// 两种模式都缺的兜底拒绝，以及合法计划经代理通道下发（不发 plan_path / scope）。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildRegistry, parseResponse, runExecutor } from "./cli-command-executors-proxy.helpers.mts";

describe("cli-command-executors canvas.layout --plan（批次 1b）", () => {
  const layoutResponse = {
    command: "canvas.layout",
    request_id: "r-layout",
    positions: { n1: { x: 10, y: 20 } },
    summary: { inspected: 1, moved: 1, unchanged: 0, skipped: [] },
    operation_id: "op-layout",
    dry_run: false,
    columns: null,
    gap: null,
    content_reordered: false,
    order_changes: [],
  };

  const planDir = mkdtempSync(join(tmpdir(), "cli-layout-plan-"));
  afterAll(() => {
    rmSync(planDir, { recursive: true, force: true });
  });

  const writePlanFile = (name: string, content: string): string => {
    const filePath = join(planDir, name);
    writeFileSync(filePath, content, "utf8");
    return filePath;
  };

  const validPlan = {
    groups: [{ group_id: "g1", columns: 2, gap: 100 }],
    positions: { n1: { x: 10, y: 20 } },
  };

  it("合法计划文件：读出内容随代理命令下发，不带 plan_path / scope，结果正常解析", async () => {
    const planPath = writePlanFile("valid.json", JSON.stringify(validPlan));
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: { ok: true, response: layoutResponse },
    });
    const result = await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      plan_path: planPath,
    });
    expect(parseResponse(result)).toMatchObject({ ok: true, command: "canvas.layout" });
    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]?.candidate).toEqual({ command: "canvas.layout", plan: validPlan });
    expect(proxyCalls[0]?.candidate).not.toHaveProperty("plan_path");
    expect(proxyCalls[0]?.candidate).not.toHaveProperty("scope");
  });

  it("--dry-run：plan 与 dry_run:true 一起下发", async () => {
    const planPath = writePlanFile("dry-run.json", JSON.stringify(validPlan));
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: { ok: true, response: { ...layoutResponse, dry_run: true } },
    });
    await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      plan_path: planPath,
      dry_run: true,
    });
    expect(proxyCalls[0]?.candidate).toEqual({
      command: "canvas.layout",
      plan: validPlan,
      dry_run: true,
    });
  });

  it("计划文件不存在 → command_rejected，消息含路径，不触达代理", async () => {
    const missingPath = join(planDir, "missing.json");
    const { registry, proxyCalls } = buildRegistry({ windowOpen: true });
    const result = await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      plan_path: missingPath,
    });
    const parsed = parseResponse(result);
    expect(parsed).toMatchObject({ ok: false, error: { code: "command_rejected" } });
    if (parsed.ok) throw new Error("unexpected");
    expect(parsed.error.message).toContain(missingPath);
    expect(parsed.error.message).toContain("读不到计划文件");
    expect(proxyCalls).toHaveLength(0);
  });

  it("非法 JSON → command_rejected", async () => {
    const planPath = writePlanFile("bad-json.json", "{ not json ");
    const { registry, proxyCalls } = buildRegistry({ windowOpen: true });
    const result = await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      plan_path: planPath,
    });
    const parsed = parseResponse(result);
    expect(parsed).toMatchObject({ ok: false, error: { code: "command_rejected" } });
    if (parsed.ok) throw new Error("unexpected");
    expect(parsed.error.message).toContain("计划文件不是合法 JSON");
    expect(parsed.error.message).toContain(planPath);
    expect(proxyCalls).toHaveLength(0);
  });

  it("schema 不符（groups[0].gap 为负）→ command_rejected，消息含字段路径", async () => {
    const planPath = writePlanFile("bad-schema.json", JSON.stringify({ groups: [{ group_id: "g1", gap: -1 }] }));
    const { registry, proxyCalls } = buildRegistry({ windowOpen: true });
    const result = await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      plan_path: planPath,
    });
    const parsed = parseResponse(result);
    expect(parsed).toMatchObject({ ok: false, error: { code: "command_rejected" } });
    if (parsed.ok) throw new Error("unexpected");
    expect(parsed.error.message).toContain("计划文件格式不正确");
    expect(parsed.error.message).toContain("groups.0.gap");
    expect(proxyCalls).toHaveLength(0);
  });

  it("plan_path 与 scope 同时出现 → command_rejected（解析器的兜底）", async () => {
    const planPath = writePlanFile("mixed.json", JSON.stringify(validPlan));
    const { registry, proxyCalls } = buildRegistry({ windowOpen: true });
    const result = await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      plan_path: planPath,
      scope: "all",
    });
    const parsed = parseResponse(result);
    expect(parsed).toMatchObject({ ok: false, error: { code: "command_rejected" } });
    if (parsed.ok) throw new Error("unexpected");
    expect(parsed.error.message).toContain("--plan");
    expect(proxyCalls).toHaveLength(0);
  });

  it("既没有 plan_path 也没有 scope → command_rejected", async () => {
    const { registry, proxyCalls } = buildRegistry({ windowOpen: true });
    const result = await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
    });
    const parsed = parseResponse(result);
    expect(parsed).toMatchObject({ ok: false, error: { code: "command_rejected" } });
    if (parsed.ok) throw new Error("unexpected");
    expect(parsed.error.message).toContain("--scope");
    expect(parsed.error.message).toContain("--plan");
    expect(proxyCalls).toHaveLength(0);
  });

  it("既有 --scope 路径行为不变：scope 原样下发、不读取计划文件", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: { ok: true, response: layoutResponse },
    });
    const result = await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      scope: "all",
    });
    expect(parseResponse(result)).toMatchObject({ ok: true, command: "canvas.layout" });
    expect(proxyCalls[0]?.candidate).toEqual({ command: "canvas.layout", scope: "all" });
  });
});
