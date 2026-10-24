// @vitest-environment node
// @spec: CLI-030, CLI-052, CLI-053, CLI-055
//
// 批次 1a 画布写命令执行器测试（从 cli-command-executors-proxy.test.mts 拆出，
// 主文件行数预算约束）：canvas.layout 的 order_mode/gap 透传与业务拒绝、
// created 排序主进程解析、canvas.nodes.move 绝对/相对两族构造与结果直通。
import { describe, expect, it } from "vitest";
import { buildRegistry, parseResponse, runExecutor } from "./cli-command-executors-proxy.helpers.mts";

describe("cli-command-executors 画布写命令（批次 1a：layout / nodes move）", () => {
  const layoutResponse = {
    command: "canvas.layout",
    request_id: "r-layout",
    positions: {},
    summary: { inspected: 0, moved: 0, unchanged: 0, skipped: [] },
    operation_id: "op-layout",
    dry_run: false,
    columns: null,
    gap: null,
    content_reordered: false,
    order_changes: [],
  };

  /** created 排序测试载荷：三个自由节点（含缺失创建时间）+ 一个组内成员 + 一个资产节点。 */
  const CREATED_ORDER_PAYLOADS: readonly unknown[] = [
    { id: "free-late", type: "task", position: { x: 0, y: 0 }, data: { createdAt: 3000 } },
    { id: "free-early", type: "task", position: { x: 0, y: 0 }, data: { createdAt: 1000 } },
    { id: "free-no-time", type: "textInput", position: { x: 0, y: 0 }, data: {} },
    // 资产节点：自身无 createdAt，取产出任务创建时间（生成来源索引随任务行读出的值）。
    { id: "free-asset", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "a-1" } },
    { id: "grouped", type: "task", position: { x: 0, y: 0 }, groupId: "g1", data: { createdAt: 500 } },
    { id: "agent-member", type: "task", position: { x: 0, y: 0 }, groupId: "g1", data: { createdAt: 700 } },
    { id: "g1", type: "group", position: { x: 0, y: 0 }, data: { name: "组一" } },
  ];

  const CREATED_ORDER_GENERATION = new Map([
    ["a-1", { taskId: "t-a1", batchId: "b-1", modelId: "m-1", prompt: "p", taskCreatedAt: 2000 }],
  ]);

  it("canvas.layout --order-mode created（scope=all）：主进程解析成显式 order，order_mode 改发 insertion", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: { ok: true, response: layoutResponse },
      canvasPayloads: CREATED_ORDER_PAYLOADS,
      generationIndex: CREATED_ORDER_GENERATION,
    });
    const result = await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      scope: "all",
      order_mode: "created",
    });
    expect(parseResponse(result)).toMatchObject({ ok: true, command: "canvas.layout" });
    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]?.candidate).toEqual({
      command: "canvas.layout",
      scope: "all",
      order: ["free-early", "free-asset", "free-late", "free-no-time"],
      order_mode: "insertion",
    });
  });

  it("canvas.layout --order-mode created（scope=group）：只取该组直接成员按创建时间升序", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: { ok: true, response: layoutResponse },
      canvasPayloads: CREATED_ORDER_PAYLOADS,
      generationIndex: CREATED_ORDER_GENERATION,
    });
    const result = await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      scope: { group: "g1" },
      order_mode: "created",
    });
    expect(parseResponse(result)).toMatchObject({ ok: true, command: "canvas.layout" });
    expect(proxyCalls[0]?.candidate).toMatchObject({
      command: "canvas.layout",
      scope: { group: "g1" },
      order: ["grouped", "agent-member"],
      order_mode: "insertion",
    });
  });

  it("canvas.layout --order 显式顺序优先于 created 排序（不解析创建时间）", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: { ok: true, response: layoutResponse },
      canvasPayloads: CREATED_ORDER_PAYLOADS,
    });
    await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      scope: "all",
      order: ["free-late", "free-early"],
      order_mode: "created",
    });
    expect(proxyCalls[0]?.candidate).toEqual({
      command: "canvas.layout",
      scope: "all",
      order: ["free-late", "free-early"],
      order_mode: "created",
    });
  });

  it("canvas.layout --scope containers --pack --order-mode created → command_rejected（零改动、不触达代理）", async () => {
    const { registry, proxyCalls } = buildRegistry({ windowOpen: true });
    const result = await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      scope: "containers",
      pack: true,
      order_mode: "created",
    });
    expect(parseResponse(result)).toMatchObject({
      ok: false,
      error: { code: "command_rejected", message: expect.stringContaining("--order") },
    });
    expect(result.errorCode).toBe("command_rejected");
    expect(proxyCalls).toHaveLength(0);
  });

  it("canvas.layout --scope containers 非 pack 带 gap/columns/order/order-mode → command_rejected（零改动）", async () => {
    const cases: Array<Record<string, unknown>> = [
      { gap: 40 },
      { columns: 2 },
      { order: ["g1"] },
      { order_mode: "insertion" },
    ];
    for (const extra of cases) {
      const { registry, proxyCalls } = buildRegistry({ windowOpen: true });
      const result = await runExecutor(registry, "canvas.layout", {
        command: "canvas.layout",
        project: "demo",
        scope: "containers",
        ...extra,
      });
      expect(parseResponse(result)).toMatchObject({ ok: false, error: { code: "command_rejected" } });
      expect(proxyCalls).toHaveLength(0);
    }
  });

  it("canvas.layout：order_mode/gap 原样透传（pack 档）", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: { ok: true, response: layoutResponse },
    });
    await runExecutor(registry, "canvas.layout", {
      command: "canvas.layout",
      project: "demo",
      scope: "containers",
      pack: true,
      columns: 3,
      gap: 40,
      order_mode: "position",
    });
    expect(proxyCalls[0]?.candidate).toEqual({
      command: "canvas.layout",
      scope: "containers",
      columns: 3,
      pack: true,
      gap: 40,
      order_mode: "position",
    });
  });

  it("canvas.layout：content_reordered/order_changes 直通到命令响应", async () => {
    const { registry } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: {
        ok: true,
        response: {
          ...layoutResponse,
          positions: { n1: { x: 0, y: 0 } },
          summary: { inspected: 1, moved: 1, cascaded: 0, unchanged: 0, skipped: [] },
          content_reordered: true,
          order_changes: [{ node_id: "n1", from_slot: 2, to_slot: 0 }],
        },
      },
    });
    const parsed = parseResponse(
      await runExecutor(registry, "canvas.layout", {
        command: "canvas.layout",
        project: "demo",
        scope: "all",
      }),
    );
    if (!parsed.ok || parsed.command !== "canvas.layout") throw new Error("unexpected");
    expect(parsed.content_reordered).toBe(true);
    expect(parsed.order_changes).toEqual([{ node_id: "n1", from_slot: 2, to_slot: 0 }]);
  });

  it("canvas.nodes.move --positions：绝对坐标族下发 positions（不带 dx/dy），落点表直通", async () => {
    const { registry, proxyCalls } = buildRegistry({
      windowOpen: true,
      dispatchOutcome: {
        ok: true,
        response: {
          command: "canvas.nodes.move",
          request_id: "r-nm",
          positions: { n1: { x: 10, y: 20 }, n2: { x: -5, y: 6 } },
          moved_node_ids: ["n1", "n2"],
          summary: { inspected: 2, moved: 2, cascaded: 0, unchanged: 0, skipped: [] },
          operation_id: "op-nm",
          dry_run: false,
        },
      },
    });
    const parsed = parseResponse(
      await runExecutor(registry, "canvas.nodes.move", {
        command: "canvas.nodes.move",
        project: "demo",
        positions: [
          { node_id: "n1", x: 10, y: 20 },
          { node_id: "n2", x: -5, y: 6 },
        ],
      }),
    );
    if (!parsed.ok || parsed.command !== "canvas.nodes.move") throw new Error("unexpected");
    expect(parsed.positions).toEqual({ n1: { x: 10, y: 20 }, n2: { x: -5, y: 6 } });
    expect(proxyCalls[0]?.candidate).toEqual({
      command: "canvas.nodes.move",
      positions: [
        { node_id: "n1", x: 10, y: 20 },
        { node_id: "n2", x: -5, y: 6 },
      ],
    });
  });

  it("canvas.nodes.move：两族同时出现或相对族缺轴 → command_rejected（不触达代理）", async () => {
    const both = buildRegistry({ windowOpen: true });
    const bothResult = await runExecutor(both.registry, "canvas.nodes.move", {
      command: "canvas.nodes.move",
      project: "demo",
      nodes: ["n1"],
      positions: [{ node_id: "n1", x: 0, y: 0 }],
    });
    expect(parseResponse(bothResult)).toMatchObject({ ok: false, error: { code: "command_rejected" } });
    expect(both.proxyCalls).toHaveLength(0);

    const incomplete = buildRegistry({ windowOpen: true });
    const incompleteResult = await runExecutor(incomplete.registry, "canvas.nodes.move", {
      command: "canvas.nodes.move",
      project: "demo",
      nodes: ["n1"],
      dx: 5,
    });
    expect(parseResponse(incompleteResult)).toMatchObject({ ok: false, error: { code: "command_rejected" } });
    expect(incomplete.proxyCalls).toHaveLength(0);
  });
});
