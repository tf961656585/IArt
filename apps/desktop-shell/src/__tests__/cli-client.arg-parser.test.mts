// @vitest-environment node
// @spec: CLI-001, CLI-004, CLI-014, CLI-015, CLI-027, CLI-028, CLI-029, CLI-030, CLI-049, CLI-050
//
// CLI 参数解析测试（参数名 → 契约字段映射表）：--ref/--arg/--scope/--order/位置参数、
// 命令级参数白名单、布尔 flag 与带值参数区分、--dry-run、帮助文本参数缺口。
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { loadParserModule } from "./cli-client.helpers.mts";

describe("parseCliArgs（参数名 → 契约字段映射表）", () => {
  const parser = loadParserModule();

  it("generate：--count/--wait/--ref 逗号拆分/--arg k=v 拆分", () => {
    const parsed = parser.parseCliArgs([
      "generate",
      "--project",
      "P",
      "--prompt",
      "T",
      "--model",
      "M",
      "--count",
      "2",
      "--ref",
      "a,b",
      "--arg",
      "k=v,k2=v2",
      "--wait",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "generate",
      project: "P",
      prompt: "T",
      model: "M",
      count: 2,
      // 不带用途时 slot_id 落 null（由提交侧按设计 §8 兜底），不是缺键
      ref: [
        { asset_id: "a", slot_id: null },
        { asset_id: "b", slot_id: null },
      ],
      arg: [
        { key: "k", value: "v" },
        { key: "k2", value: "v2" },
      ],
      wait: true,
    });
  });

  // @spec: CLI-033
  it("generate：--request-id 映射为契约 client_request_id（受理幂等键）", () => {
    const parsed = parser.parseCliArgs([
      "generate",
      "--project",
      "P",
      "--prompt",
      "T",
      "--model",
      "M",
      "--request-id",
      "req-abc",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toMatchObject({ command: "generate", client_request_id: "req-abc" });
  });

  // @spec: CLI-034
  it("task list：--status/--since/--request-id 解析为契约过滤字段；缺省时字段缺省", () => {
    const filtered = parser.parseCliArgs([
      "task",
      "list",
      "--project",
      "P",
      "--status",
      "failed",
      "--since",
      "2026-10-14T00:00:00Z",
      "--request-id",
      "req-1",
    ]);
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) throw new Error("unreachable");
    expect(filtered.request).toEqual({
      command: "task.list",
      project: "P",
      status: "failed",
      since: "2026-10-14T00:00:00Z",
      client_request_id: "req-1",
    });

    // 缺省：契约 default 物化为不过滤语义（旧客户端兼容）
    const bare = parser.parseCliArgs(["task", "list", "--project", "P"]);
    expect(bare.ok).toBe(true);
    if (!bare.ok) throw new Error("unreachable");
    expect(bare.request).toEqual({
      command: "task.list",
      project: "P",
      status: null,
      since: null,
      client_request_id: null,
    });

    // 非法 status：契约枚举在发送前校验失败（本地报参数错误）
    const badStatus = parser.parseCliArgs(["task", "list", "--project", "P", "--status", "bogus"]);
    expect(badStatus.ok).toBe(false);
  });

  it("canvas layout：--scope group:<id> 映射为 { group } 对象形态，--columns 解析为数字", () => {
    const parsed = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--scope", "group:g1", "--columns", "3"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.layout",
      project: "P",
      scope: { group: "g1" },
      columns: 3,
    });
  });

  it("canvas layout：--scope all 映射为字面量", () => {
    const parsed = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--scope", "all"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect((parsed.request as { scope: unknown }).scope).toBe("all");
  });

  it("位置参数：model get <model_id>、task wait <taskId>", () => {
    const modelGet = parser.parseCliArgs(["model", "get", "gpt-image-2"]);
    expect(modelGet.ok).toBe(true);
    if (!modelGet.ok) throw new Error("unreachable");
    expect(modelGet.request).toEqual({ command: "model.get", model_id: "gpt-image-2" });

    const taskWait = parser.parseCliArgs(["task", "wait", "task-1", "--project", "P", "--timeout", "30"]);
    expect(taskWait.ok).toBe(true);
    if (!taskWait.ok) throw new Error("unreachable");
    expect(taskWait.request).toEqual({
      command: "task.wait",
      project: "P",
      task_id: "task-1",
      timeout: 30,
    });
  });

  it("canvas group create：--members 逗号拆分为数组", () => {
    const parsed = parser.parseCliArgs(["canvas", "group", "create", "--project", "P", "--name", "G", "--members", "n1,n2"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.group.create",
      project: "P",
      name: "G",
      members: ["n1", "n2"],
    });
  });

  it("canvas group dissolve：--group 解析为契约 group 字段（CLI-027）", () => {
    const parsed = parser.parseCliArgs(["canvas", "group", "dissolve", "--project", "P", "--group", "g1"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.group.dissolve",
      project: "P",
      group: "g1",
    });

    const missing = parser.parseCliArgs(["canvas", "group", "dissolve", "--project", "P"]);
    expect(missing.ok).toBe(false);
  });

  // @spec: CLI-049
  it("canvas group add/remove：--group 与 --members 映射契约字段，members 缺少时报错", () => {
    const add = parser.parseCliArgs([
      "canvas", "group", "add", "--project", "P", "--group", "g1", "--members", "n1,n2",
    ]);
    expect(add.ok).toBe(true);
    if (!add.ok) throw new Error("unreachable");
    expect(add.request).toEqual({
      command: "canvas.group.add",
      project: "P",
      group: "g1",
      members: ["n1", "n2"],
    });

    const remove = parser.parseCliArgs([
      "canvas", "group", "remove", "--project", "P", "--group", "g1", "--members", "n1",
    ]);
    expect(remove.ok).toBe(true);
    if (!remove.ok) throw new Error("unreachable");
    expect(remove.request).toEqual({
      command: "canvas.group.remove",
      project: "P",
      group: "g1",
      members: ["n1"],
    });

    const missingMembers = parser.parseCliArgs([
      "canvas", "group", "add", "--project", "P", "--group", "g1",
    ]);
    expect(missingMembers.ok).toBe(false);
  });

  it("canvas node move：--node/--x/--y 解析，坐标允许负数与小数（CLI-028）", () => {
    const parsed = parser.parseCliArgs(["canvas", "node", "move", "--project", "P", "--node", "n1", "--x", "-120", "--y", "240.5"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.node.move",
      project: "P",
      node: "n1",
      x: -120,
      y: 240.5,
    });

    const inline = parser.parseCliArgs(["canvas", "node", "move", "--project=P", "--node=n1", "--x=3", "--y=-4"]);
    expect(inline.ok).toBe(true);
    if (!inline.ok) throw new Error("unreachable");
    expect(inline.request).toEqual({ command: "canvas.node.move", project: "P", node: "n1", x: 3, y: -4 });

    const notNumber = parser.parseCliArgs(["canvas", "node", "move", "--project", "P", "--node", "n1", "--x", "abc", "--y", "1"]);
    expect(notNumber.ok).toBe(false);

    const missingY = parser.parseCliArgs(["canvas", "node", "move", "--project", "P", "--node", "n1", "--x", "1"]);
    expect(missingY.ok).toBe(false);
  });

  it("canvas node delete：--nodes 逗号拆分为数组，缺参报错（CLI-029）", () => {
    const parsed = parser.parseCliArgs(["canvas", "node", "delete", "--project", "P", "--nodes", "n1,n2"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.node.delete",
      project: "P",
      nodes: ["n1", "n2"],
    });

    const repeated = parser.parseCliArgs(["canvas", "node", "delete", "--project", "P", "--nodes", "n1", "--nodes", "n2"]);
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) throw new Error("unreachable");
    expect(repeated.request).toEqual({ command: "canvas.node.delete", project: "P", nodes: ["n1", "n2"] });

    const missing = parser.parseCliArgs(["canvas", "node", "delete", "--project", "P"]);
    expect(missing.ok).toBe(false);
  });

  it("canvas node create：--asset/--group/--x/--y/--dry-run 组合解析，缺 asset 与单轴报错（CLI-056）", () => {
    const full = parser.parseCliArgs([
      "canvas", "node", "create",
      "--project", "P",
      "--asset", "a1",
      "--group", "g1",
      "--x", "-10.5",
      "--y", "20",
      "--dry-run",
    ]);
    expect(full.ok).toBe(true);
    if (!full.ok) throw new Error("unreachable");
    expect(full.request).toEqual({
      command: "canvas.node.create",
      project: "P",
      asset: "a1",
      group: "g1",
      x: -10.5,
      y: 20,
      dry_run: true,
    });

    // group / x / y / dry-run 均可省略
    const minimal = parser.parseCliArgs(["canvas", "node", "create", "--project", "P", "--asset", "a1"]);
    expect(minimal.ok).toBe(true);
    if (!minimal.ok) throw new Error("unreachable");
    expect(minimal.request).toEqual({ command: "canvas.node.create", project: "P", asset: "a1" });

    // asset 必填
    const missingAsset = parser.parseCliArgs(["canvas", "node", "create", "--project", "P"]);
    expect(missingAsset.ok).toBe(false);
    if (missingAsset.ok) throw new Error("unreachable");
    expect(missingAsset.reason).toBe("usage-error");

    // x/y 只给一个轴：解析器按用法错误拒绝（执行侧另有 command_rejected 兜底）
    for (const axisArgs of [["--x", "1"], ["--y", "2"]]) {
      const singleAxis = parser.parseCliArgs(["canvas", "node", "create", "--project", "P", "--asset", "a1", ...axisArgs]);
      expect(singleAxis.ok).toBe(false);
      if (singleAxis.ok) throw new Error("unreachable");
      expect(singleAxis.reason).toBe("usage-error");
      expect(singleAxis.message).toContain("--x 与 --y");
    }

    // 坐标必须是有限数值
    const notNumber = parser.parseCliArgs([
      "canvas", "node", "create", "--project", "P", "--asset", "a1", "--x", "abc", "--y", "1",
    ]);
    expect(notNumber.ok).toBe(false);
  });

  it("asset list --on-canvas：true/false 解析为布尔，非法值报错（CLI-056）", () => {
    const onCanvas = parser.parseCliArgs(["asset", "list", "--project", "P", "--on-canvas", "true"]);
    expect(onCanvas.ok).toBe(true);
    if (!onCanvas.ok) throw new Error("unreachable");
    expect(onCanvas.request).toMatchObject({ command: "asset.list", project: "P", on_canvas: true });

    const offCanvas = parser.parseCliArgs(["asset", "list", "--project", "P", "--on-canvas", "false"]);
    expect(offCanvas.ok).toBe(true);
    if (!offCanvas.ok) throw new Error("unreachable");
    expect(offCanvas.request).toMatchObject({ command: "asset.list", project: "P", on_canvas: false });

    const invalid = parser.parseCliArgs(["asset", "list", "--project", "P", "--on-canvas", "yes"]);
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("unreachable");
    expect(invalid.reason).toBe("usage-error");
    expect(invalid.message).toContain("--on-canvas");
  });

  it("canvas layout：--order 逗号拆分为显式顺序数组（CLI-030）", () => {
    const parsed = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--scope", "group:g1", "--order", "m3,m1,m2"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.layout",
      project: "P",
      scope: { group: "g1" },
      order: ["m3", "m1", "m2"],
    });

    // 缺省不带 --order：请求形状与既有行为完全一致（默认排序行为不变）
    const bare = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--scope", "all"]);
    expect(bare.ok).toBe(true);
    if (!bare.ok) throw new Error("unreachable");
    expect(bare.request).toEqual({ command: "canvas.layout", project: "P", scope: "all" });
  });

  // @spec: CLI-030, CLI-048
  it("canvas layout --plan：解析为绝对路径 plan_path，--dry-run 两种模式都可用", () => {
    const relative = parser.parseCliArgs([
      "canvas",
      "layout",
      "--project",
      "P",
      "--plan",
      "plans/layout.json",
      "--dry-run",
    ]);
    expect(relative.ok).toBe(true);
    if (!relative.ok) throw new Error("unreachable");
    expect(relative.request).toEqual({
      command: "canvas.layout",
      project: "P",
      plan_path: path.resolve("plans/layout.json"),
      dry_run: true,
    });

    const absolute = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--plan", "/tmp/plan.json"]);
    expect(absolute.ok).toBe(true);
    if (!absolute.ok) throw new Error("unreachable");
    expect(absolute.request).toMatchObject({ command: "canvas.layout", plan_path: "/tmp/plan.json" });
  });

  // @spec: CLI-030, CLI-048
  it("canvas layout --plan 与 --scope 族互斥，两者都缺按用法错误拒绝，--plan 不接受标准输入", () => {
    for (const competing of [
      ["--scope", "all"],
      ["--columns", "2"],
      ["--order", "a,b"],
      ["--order-mode", "position"],
      ["--gap", "10"],
      ["--pack"],
    ]) {
      const parsed = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--plan", "p.json", ...competing]);
      expect(parsed.ok, competing.join(" ")).toBe(false);
      if (parsed.ok) throw new Error("unreachable");
      expect(parsed.reason).toBe("usage-error");
      expect(parsed.message).toContain("--plan");
    }

    const neither = parser.parseCliArgs(["canvas", "layout", "--project", "P"]);
    expect(neither.ok).toBe(false);
    if (neither.ok) throw new Error("unreachable");
    expect(neither.reason).toBe("usage-error");
    expect(neither.message).toContain("--plan");

    for (const plan of ["-", ""]) {
      const parsed = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--plan", plan]);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error("unreachable");
      expect(parsed.reason).toBe("usage-error");
    }
  });

  // @spec: CLI-052, CLI-053, CLI-054
  it("canvas group move：相对位移 / 绝对落点互斥，缺参报错，--dry-run 解析", () => {
    const relative = parser.parseCliArgs([
      "canvas", "group", "move", "--project", "P", "--group", "g1", "--dx", "10", "--dy", "-4.5",
    ]);
    expect(relative.ok).toBe(true);
    if (!relative.ok) throw new Error("unreachable");
    expect(relative.request).toEqual({
      command: "canvas.group.move",
      project: "P",
      group: "g1",
      dx: 10,
      dy: -4.5,
    });

    const absolute = parser.parseCliArgs([
      "canvas", "group", "move", "--project", "P", "--group", "g1", "--x", "0", "--y", "120", "--dry-run",
    ]);
    expect(absolute.ok).toBe(true);
    if (!absolute.ok) throw new Error("unreachable");
    expect(absolute.request).toEqual({
      command: "canvas.group.move",
      project: "P",
      group: "g1",
      x: 0,
      y: 120,
      dry_run: true,
    });

    // 两族互斥：同时出现 → 用法错误（执行侧另有 command_rejected 兜底）
    const mixed = parser.parseCliArgs([
      "canvas", "group", "move", "--project", "P", "--group", "g1", "--dx", "1", "--y", "2",
    ]);
    expect(mixed.ok).toBe(false);

    // 两族都没给 → 用法错误
    const empty = parser.parseCliArgs(["canvas", "group", "move", "--project", "P", "--group", "g1"]);
    expect(empty.ok).toBe(false);

    // 缺 --group → 用法错误
    const missingGroup = parser.parseCliArgs(["canvas", "group", "move", "--project", "P", "--dx", "1"]);
    expect(missingGroup.ok).toBe(false);
  });

  it("canvas nodes move：--nodes 逗号拆分、--dx/--dy 必填、--dry-run 解析", () => {
    const parsed = parser.parseCliArgs([
      "canvas", "nodes", "move", "--project", "P", "--nodes", "n1,n2", "--dx", "5", "--dy", "6",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "canvas.nodes.move",
      project: "P",
      nodes: ["n1", "n2"],
      dx: 5,
      dy: 6,
    });

    const dry = parser.parseCliArgs([
      "canvas", "nodes", "move", "--project", "P", "--nodes", "n1", "--dx", "0", "--dy", "0", "--dry-run",
    ]);
    expect(dry.ok).toBe(true);
    if (!dry.ok) throw new Error("unreachable");
    expect(dry.request).toMatchObject({ command: "canvas.nodes.move", dry_run: true });

    expect(
      parser.parseCliArgs(["canvas", "nodes", "move", "--project", "P", "--nodes", "n1", "--dy", "1"]).ok,
    ).toBe(false);
    expect(parser.parseCliArgs(["canvas", "nodes", "move", "--project", "P", "--dx", "1", "--dy", "1"]).ok).toBe(false);
  });

  it("canvas undo：--operation 必填", () => {
    const parsed = parser.parseCliArgs(["canvas", "undo", "--project", "P", "--operation", "op-1"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({ command: "canvas.undo", project: "P", operation: "op-1" });
    expect(parser.parseCliArgs(["canvas", "undo", "--project", "P"]).ok).toBe(false);
  });

  it("canvas layout / canvas node move：--dry-run 解析为 dry_run=true（缺省不带该字段）", () => {
    const dry = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--scope", "containers", "--dry-run"]);
    expect(dry.ok).toBe(true);
    if (!dry.ok) throw new Error("unreachable");
    expect(dry.request).toMatchObject({ command: "canvas.layout", dry_run: true });

    const bare = parser.parseCliArgs(["canvas", "layout", "--project", "P", "--scope", "all"]);
    expect(bare.ok).toBe(true);
    if (!bare.ok) throw new Error("unreachable");
    expect(bare.request).not.toHaveProperty("dry_run");

    const nodeDry = parser.parseCliArgs([
      "canvas", "node", "move", "--project", "P", "--node", "n1", "--x", "1", "--y", "2", "--dry-run",
    ]);
    expect(nodeDry.ok).toBe(true);
    if (!nodeDry.ok) throw new Error("unreachable");
    expect(nodeDry.request).toMatchObject({ command: "canvas.node.move", dry_run: true });
  });

  it("asset import：--file 重复累积为数组且含逗号路径不拆分；缺 --file/--project 报错", () => {
    const parsed = parser.parseCliArgs([
      "asset",
      "import",
      "--project",
      "P",
      "--file",
      "/tmp/a.png",
      "--file",
      "/tmp/b,c.mp4",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({
      command: "asset.import",
      project: "P",
      // 路径可合法含逗号：--file 是 pathList 语义（整项累积），不做逗号拆分
      file: ["/tmp/a.png", "/tmp/b,c.mp4"],
    });

    // 内联 = 形态（--file=<路径>、--project=P）
    const inline = parser.parseCliArgs(["asset", "import", "--project=P", "--file=/tmp/x=y.png"]);
    expect(inline.ok).toBe(true);
    if (!inline.ok) throw new Error("unreachable");
    expect(inline.request).toEqual({ command: "asset.import", project: "P", file: ["/tmp/x=y.png"] });

    const missingFile = parser.parseCliArgs(["asset", "import", "--project", "P"]);
    expect(missingFile.ok).toBe(false);
    if (missingFile.ok) throw new Error("unreachable");
    expect(missingFile.message).toContain("--file");
    const missingProject = parser.parseCliArgs(["asset", "import", "--file", "/tmp/a.png"]);
    expect(missingProject.ok).toBe(false);
    expect(parser.CLI_USAGE_TEXT).toContain("iart asset import");
  });

  it("布尔 flag 与带值参数区分：--wait=x 报错、缺值报错、未知参数报错", () => {
    const boolWithValue = parser.parseCliArgs(["generate", "--wait=x"]);
    expect(boolWithValue.ok).toBe(false);

    const missingValue = parser.parseCliArgs(["generate", "--model"]);
    expect(missingValue.ok).toBe(false);

    const unknown = parser.parseCliArgs(["generate", "--nope", "x"]);
    expect(unknown.ok).toBe(false);
  });

  it("app status：无参数解析为 app.status 请求；多余位置参数被拒（spec §5.5）", () => {
    const parsed = parser.parseCliArgs(["app", "status"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({ command: "app.status" });

    const extra = parser.parseCliArgs(["app", "status", "extra"]);
    expect(extra.ok).toBe(false);
  });

  // @spec: CLI-041
  it("按命令参数白名单拒绝：task list / app status 的 --limit 被拒，asset list 的 --limit 正常", () => {
    const taskRejected = parser.parseCliArgs(["task", "list", "--project", "P", "--limit", "2"]);
    expect(taskRejected.ok).toBe(false);
    if (taskRejected.ok) throw new Error("unreachable");
    expect(taskRejected.message).toContain("参数 --limit 不适用于命令 task list");

    const appRejected = parser.parseCliArgs(["app", "status", "--limit", "2"]);
    expect(appRejected.ok).toBe(false);
    if (appRejected.ok) throw new Error("unreachable");
    expect(appRejected.message).toContain("参数 --limit 不适用于命令 app status");

    // 合法命令与合法参数组合行为不变：asset list 是唯一支持分页的列表命令
    const assetAccepted = parser.parseCliArgs(["asset", "list", "--project", "P", "--limit", "2"]);
    expect(assetAccepted.ok).toBe(true);
    if (!assetAccepted.ok) throw new Error("unreachable");
    expect(assetAccepted.request).toMatchObject({ command: "asset.list", project: "P", limit: 2 });
  });

  // @spec: CLI-041
  it("命令级帮助补齐参数缺口：asset get 位置参数名、task get 必填 --project、canvas layout --columns 默认值、task wait --timeout 默认不设", () => {
    const assetGetHelp = parser.renderCliHelpText({ kind: "command", phrase: "asset get" });
    expect(assetGetHelp).toContain("iart asset get <assetId> --project P");
    expect(assetGetHelp).toContain("--project <路径或名称>");
    expect(assetGetHelp).toContain("（必填）");

    const taskGetHelp = parser.renderCliHelpText({ kind: "command", phrase: "task get" });
    expect(taskGetHelp).toContain("iart task get <taskId> --project P");
    expect(taskGetHelp).toContain("--project <路径或名称>");

    const layoutHelp = parser.renderCliHelpText({ kind: "command", phrase: "canvas layout" });
    expect(layoutHelp).toContain("--columns <N>");
    expect(layoutHelp).toContain("缺省 1");

    const waitHelp = parser.renderCliHelpText({ kind: "command", phrase: "task wait" });
    expect(waitHelp).toContain("--timeout <秒>");
    expect(waitHelp).toContain("缺省不设时限");

    // 顶层仍保留完整命令面（含 batch get 与 status 七枚举）
    expect(parser.CLI_USAGE_TEXT).toContain("iart batch get <batchId> --project P");
    expect(parser.CLI_USAGE_TEXT).toContain("--version");
  });

  // @spec: CLI-041
  it("名词帮助支持两级名词：--help 之前的前缀命中即渲染该名词下的子命令", () => {
    const cases: Array<{ argv: string[]; noun: string; expectText: string }> = [
      { argv: ["canvas", "--help"], noun: "canvas", expectText: "iart canvas group create" },
      { argv: ["canvas", "nodes", "--help"], noun: "canvas nodes", expectText: "iart canvas nodes list" },
      { argv: ["canvas", "node", "--help"], noun: "canvas node", expectText: "iart canvas node move" },
      { argv: ["canvas", "group", "--help"], noun: "canvas group", expectText: "iart canvas group rename" },
    ];
    for (const item of cases) {
      const parsed = parser.parseCliArgs(item.argv);
      expect(parsed.ok, item.argv.join(" ")).toBe(false);
      if (parsed.ok) throw new Error("unreachable");
      expect(parsed.reason).toBe("help");
      expect(parsed.topic).toEqual({ kind: "noun", noun: item.noun });
      const text = parser.renderCliHelpText({ kind: "noun", noun: item.noun });
      expect(text, item.noun).toContain(`iart ${item.noun} —`);
      expect(text, item.noun).toContain(item.expectText);
    }

    // 单级名词仍列出下级名词入口与全部子命令（既有语义不丢）
    const canvasText = parser.renderCliHelpText({ kind: "noun", noun: "canvas" });
    expect(canvasText).toContain("下级名词：");
    expect(canvasText).toContain("iart canvas nodes --help");
    expect(canvasText).toContain("iart canvas inspect");
  });

  // @spec: CLI-041
  it("完整命令短语的 --help 行为不变：仍走命令级帮助", () => {
    const generate = parser.parseCliArgs(["generate", "--help"]);
    if (generate.ok) throw new Error("unreachable");
    expect(generate.topic).toEqual({ kind: "command", phrase: "generate" });

    const taskList = parser.parseCliArgs(["task", "list", "--help"]);
    if (taskList.ok) throw new Error("unreachable");
    expect(taskList.topic).toEqual({ kind: "command", phrase: "task list" });

    // 未知名词前缀仍按无法识别的命令失败
    const unknown = parser.parseCliArgs(["canvas", "ghost", "--help"]);
    if (unknown.ok) throw new Error("unreachable");
    expect(unknown.reason).toBe("usage-error");
  });

  // @spec: CLI-057
  it("project list：--limit/--offset 与 asset list 同形（limit 正整数、offset 非负整数）", () => {
    const bare = parser.parseCliArgs(["project", "list"]);
    expect(bare.ok).toBe(true);
    if (!bare.ok) throw new Error("unreachable");
    expect(bare.request).toEqual({ command: "project.list", limit: null, offset: 0 });

    const paged = parser.parseCliArgs(["project", "list", "--limit", "5", "--offset", "2"]);
    expect(paged.ok).toBe(true);
    if (!paged.ok) throw new Error("unreachable");
    expect(paged.request).toMatchObject({ command: "project.list", limit: 5, offset: 2 });

    const zeroOffset = parser.parseCliArgs(["project", "list", "--offset", "0"]);
    expect(zeroOffset.ok).toBe(true);

    const badLimit = parser.parseCliArgs(["project", "list", "--limit", "0"]);
    if (badLimit.ok) throw new Error("unreachable");
    expect(badLimit.message).toContain("需要正整数");

    const badOffset = parser.parseCliArgs(["project", "list", "--offset", "-1"]);
    if (badOffset.ok) throw new Error("unreachable");
    expect(badOffset.message).toContain("需要非负整数");
  });

  // @spec: CLI-057
  it("canvas group rename：--group/--name 映射契约字段；组名去空白后为空报错", () => {
    const parsed = parser.parseCliArgs([
      "canvas", "group", "rename", "--project", "P", "--group", "g1", "--name", "  新组名  ",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.request).toEqual({ command: "canvas.group.rename", project: "P", group: "g1", name: "新组名" });

    const blank = parser.parseCliArgs([
      "canvas", "group", "rename", "--project", "P", "--group", "g1", "--name", "   ",
    ]);
    if (blank.ok) throw new Error("unreachable");
    expect(blank.message).toContain("--name 不能为空");

    const missing = parser.parseCliArgs(["canvas", "group", "rename", "--project", "P", "--group", "g1"]);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.message).toContain("缺少必填参数 --name");
  });
});
