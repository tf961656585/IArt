// @vitest-environment node
// @spec: CLI-001, CLI-004, CLI-014, CLI-015, CLI-027, CLI-028, CLI-029, CLI-030, CLI-049, CLI-050
//
// CLI 客户端人读渲染测试（fetchImpl 注入固定响应）：
// 失败原因透传与截断、尺寸提示、组成员分类输出、asset import 逐文件输出、
// generate 受理幂等键回执（CLI-033/CLI-035/CLI-047/CLI-049/CLI-050）。
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  jsonResponse,
  loadClientModule,
  writeDiscoveryFile,
} from "./cli-client.helpers.mts";

// ---------------------------------------------------------------------------
// 人读失败原因透传与 generate 受理幂等键回执（fetchImpl 注入固定响应，CLI-033/CLI-035）
// ---------------------------------------------------------------------------

describe("cli-client 人读失败原因与幂等键回执（fetchImpl 注入）", () => {
  const client = loadClientModule();
  const discoveryFilePath = join(tmpdir(), `cli-client-idem-${process.pid}`, "cli-runtime.json");

  beforeAll(() => {
    mkdirSync(join(tmpdir(), `cli-client-idem-${process.pid}`), { recursive: true });
    writeDiscoveryFile(discoveryFilePath, {
      port: 59999,
      token: "unused-injected-fetch",
      pid: process.pid,
      version: "test-1.0.0",
      startedAt: new Date().toISOString(),
    });
  });

  // @spec: CLI-035
  it("task get 人读：终态失败任务输出失败原因，超 200 字符截断", async () => {
    const longMessage = "很长的失败说明。".repeat(40); // 320 字符
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "task.get",
        ok: true,
        task: {
          taskId: "task-f-1",
          status: "failed",
          projectPath: "/tmp/p",
          createdAt: 1,
          updatedAt: 2,
          errorCode: "PUBLIC_ERROR_DEMO",
          errorMessage: longMessage,
        },
        node_id: null,
        group_id: null,
      });
    const result = await client.runCliClient(["task", "get", "task-f-1", "--project", "P"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("task-f-1");
    expect(result.stdout).toContain("failed");
    expect(result.stdout).toContain("失败原因：[PUBLIC_ERROR_DEMO]");
    // 截断：人读行只保留首 200 字符 + 省略号，不整段倾倒
    expect(result.stdout).toContain(longMessage.slice(0, 200));
    expect(result.stdout).not.toContain(longMessage.slice(0, 201));
  });

  // @spec: CLI-035
  it("task get 人读：errorMessage 缺省回落 failure.userMessage；非失败任务不输出原因行", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "task.get",
        ok: true,
        task: {
          taskId: "task-f-2",
          status: "failed",
          projectPath: "/tmp/p",
          createdAt: 1,
          updatedAt: 2,
          failure: { code: "UPSTREAM_5XX", userMessage: "服务商暂时不可用，请稍后重试。" },
        },
        node_id: null,
        group_id: null,
      });
    const result = await client.runCliClient(["task", "get", "task-f-2", "--project", "P"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.stdout).toContain("失败原因：[UPSTREAM_5XX] 服务商暂时不可用，请稍后重试。");

    const okFetch: typeof fetch = async () =>
      jsonResponse({
        command: "task.get",
        ok: true,
        task: { taskId: "task-ok", status: "succeeded", projectPath: "/tmp/p", createdAt: 1, updatedAt: 2 },
        node_id: null,
        group_id: null,
      });
    const okResult = await client.runCliClient(["task", "get", "task-ok", "--project", "P"], {
      discoveryFilePath,
      fetchImpl: okFetch,
    });
    expect(okResult.stdout).not.toContain("失败原因");
  });

  // @spec: CLI-035
  it("task list 人读：失败任务行内联失败原因，成功任务行不带", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "task.list",
        ok: true,
        tasks: [
          { taskId: "t-ok", status: "succeeded", projectPath: "/tmp/p", createdAt: 1, updatedAt: 2 },
          {
            taskId: "t-bad",
            status: "failed",
            projectPath: "/tmp/p",
            createdAt: 1,
            updatedAt: 2,
            errorMessage: "参数越界",
          },
        ],
      });
    const result = await client.runCliClient(["task", "list", "--project", "P"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.stdout).toContain("t-ok：succeeded");
    expect(result.stdout).toContain("t-bad：failed，失败原因：参数越界");
  });

  // @spec: CLI-050
  it("task wait 人读：终态尺寸提示追加在结果行后，成功语义不变", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { command?: string };
      if (body.command === "task.get") {
        return jsonResponse({
          command: "task.get",
          ok: true,
          task: { taskId: "t-size", status: "succeeded", projectPath: "/tmp/p", createdAt: 1, updatedAt: 2 },
          node_id: null,
          group_id: null,
        });
      }
      return jsonResponse({
        command: "task.wait",
        ok: true,
        task_result: {
          task: { taskId: "t-size", status: "succeeded", projectPath: "/tmp/p", createdAt: 1, updatedAt: 2 },
          assets: [],
          warnings: [
            {
              code: "requested_size_not_honored",
              message: "请求尺寸 2560x1440，实际产出 1903x2560。生成任务已成功，尺寸以实际产物为准。",
              requested_size: "2560x1440",
              actual_sizes: ["1903x2560"],
            },
          ],
          node_id: null,
          group_id: null,
        },
      });
    };
    const result = await client.runCliClient(["task", "wait", "t-size", "--project", "P"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("任务 t-size：succeeded");
    expect(result.stdout).toContain("提示：请求尺寸 2560x1440，实际产出 1903x2560");
  });

  // @spec: CLI-049
  it("canvas group add/remove 人读：加入按新增/迁移/未变分类输出，移出说明保留原位", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { command?: string };
      if (body.command === "canvas.group.add") {
        return jsonResponse({
          command: "canvas.group.add",
          ok: true,
          group_node_id: "g1",
          added_node_ids: ["n1"],
          moved_node_ids: ["n2"],
          unchanged_node_ids: ["n3"],
          operation_id: "op-add",
        });
      }
      return jsonResponse({
        command: "canvas.group.remove",
        ok: true,
        group_node_id: "g1",
        removed_node_ids: ["n1"],
        operation_id: "op-remove",
      });
    };

    const added = await client.runCliClient(
      ["canvas", "group", "add", "--project", "P", "--group", "g1", "--members", "n1,n2,n3"],
      { discoveryFilePath, fetchImpl },
    );
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain("组 g1 成员已更新");
    expect(added.stdout).toContain("加入 1 个");
    expect(added.stdout).toContain("从其他组迁入 1 个");
    expect(added.stdout).toContain("已在组内 1 个");

    const removed = await client.runCliClient(
      ["canvas", "group", "remove", "--project", "P", "--group", "g1", "--members", "n1"],
      { discoveryFilePath, fetchImpl },
    );
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain("组 g1：已移出 1 个成员");
    expect(removed.stdout).toContain("保留在画布原位");
  });

  // @spec: CLI-018, CLI-041
  it("asset list --limit：合法分页参数照常发送并成功（命令白名单不误伤）", async () => {
    const requestBodies: unknown[] = [];
    const fetchImpl: typeof fetch = (async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as unknown);
      return jsonResponse({ command: "asset.list", ok: true, assets: [] });
    }) as typeof fetch;
    const result = await client.runCliClient(["asset", "list", "--project", "P", "--limit", "2"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(requestBodies[0]).toMatchObject({ command: "asset.list", project: "P", limit: 2 });
  });

  // @spec: CLI-033
  it("generate 非 --wait：未显式传 --request-id 时客户端自动生成 uuid 并在回执回显", async () => {
    const requestBodies: unknown[] = [];
    // 假服务端按真实链路语义把请求携带的幂等键回显进受理响应（真实链路中该回显经
    // 画布窗口纯入口从 intent 原样返回）。
    const fetchImpl: typeof fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { client_request_id?: string };
      requestBodies.push(body);
      return jsonResponse({
        command: "generate",
        ok: true,
        batch_id: "batch-auto-1",
        tasks: [{ task_id: "task-auto-1", task_index: 0, node_id: null, group_id: null }],
        replayed: false,
        ...(body.client_request_id !== undefined ? { client_request_id: body.client_request_id } : {}),
        task_results: [],
      });
    }) as typeof fetch;
    const result = await client.runCliClient(["generate", "--project", "P", "--prompt", "T", "--model", "M"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    const requestBody = requestBodies[0] as { client_request_id?: string };
    expect(typeof requestBody.client_request_id).toBe("string");
    expect(requestBody.client_request_id?.length).toBeGreaterThan(10);
    // 回执回显幂等键
    expect(result.stdout).toContain("幂等键");
    expect(result.stdout).toContain(requestBody.client_request_id ?? "");
  });

  // @spec: CLI-033
  it("generate 非 --wait：显式 --request-id 原样透传；命中重放时人读回执说明未重复创建", async () => {
    const requestBodies: unknown[] = [];
    const fetchImpl: typeof fetch = (async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as unknown);
      return jsonResponse({
        command: "generate",
        ok: true,
        batch_id: "batch-replay-1",
        tasks: [{ task_id: "task-replay-1", task_index: 0, node_id: null, group_id: null }],
        client_request_id: "req-explicit-1",
        replayed: true,
        task_results: [],
      });
    }) as typeof fetch;
    const result = await client.runCliClient(
      ["generate", "--project", "P", "--prompt", "T", "--model", "M", "--request-id", "req-explicit-1"],
      { discoveryFilePath, fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    expect(requestBodies[0]).toMatchObject({ client_request_id: "req-explicit-1" });
    expect(result.stdout).toContain("req-explicit-1");
    expect(result.stdout).toContain("未重复创建");
  });
});

// ---------------------------------------------------------------------------
// 批次 1a：inspect 分档/几何人读、nodes list headline、layout 顺序变化、nodes move 落点表
// ---------------------------------------------------------------------------

describe("cli-client 人读渲染 画布 inspect / layout / nodes move（批次 1a）", () => {
  const client = loadClientModule();
  const tempRoot = join(tmpdir(), `cli-client-canvas-1a-${process.pid}`);
  const discoveryFilePath = join(tempRoot, "cli-runtime.json");

  beforeAll(() => {
    mkdirSync(tempRoot, { recursive: true });
    writeDiscoveryFile(discoveryFilePath, {
      port: 59999,
      token: "unused-injected-fetch",
      pid: process.pid,
      version: "test-1.0.0",
      startedAt: new Date().toISOString(),
    });
  });

  it("canvas inspect 人读：计数量、viewport 宽高、容器最近邻与 min_gap、overlaps 摘要；compact 不打印资产路径", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "canvas.inspect",
        ok: true,
        fidelity: "exact",
        nodes: [
          {
            node_id: "n1",
            node_type: "asset",
            name: "猫图",
            position: { x: 0, y: 0 },
            size: { width: 320, height: 240 },
            bbox: { x: 0, y: 0, width: 320, height: 240 },
            group_id: null,
            asset_id: "a1",
            task_id: null,
            batch_id: null,
            created_at: null,
            prompt_preview: null,
            source_file_name: "猫.png",
            asset: null,
          },
        ],
        containers: [
          {
            group_node_id: "g1",
            name: "组一",
            type: "group",
            member_ids: ["n1"],
            position: { x: -12, y: -40 },
            size: { width: 344, height: 304 },
            bbox: { x: -12, y: -40, width: 344, height: 304 },
            collapsed: false,
            nearest_neighbor: { node_id: "g2", gap: 60 },
          },
          {
            group_node_id: "g2",
            name: "组二",
            type: "group",
            member_ids: [],
            position: { x: 400, y: 0 },
            size: { width: 240, height: 72 },
            bbox: { x: 400, y: 0, width: 240, height: 72 },
            collapsed: false,
            nearest_neighbor: { node_id: "g1", gap: 60 },
          },
        ],
        assets_not_on_canvas: [],
        viewport: { x: 0, y: 0, zoom: 1, width: 1280, height: 800 },
        selection: null,
        annotations: [],
        overlaps: [],
        min_gap: { a_id: "g1", b_id: "g2", gap: 60 },
      });
    const result = await client.runCliClient(["canvas", "inspect", "--project", "P"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("节点 1 个，容器 2 个，未落画布资产 0 个，注释 0 个");
    expect(result.stdout).toContain("缩放 1，画布 1280x800");
    expect(result.stdout).toContain("顶层容器最小间距 60（g1 ↔ g2）");
    expect(result.stdout).toContain("重叠：没有相交的顶层容器");
    expect(result.stdout).toContain("最近邻 g2（间距 60）");
    // compact：asset=null ⇒ 不打印本地文件路径
    expect(result.stdout).not.toContain("/media/");
  });

  it("canvas inspect 人读：overlaps 摘要与 --full 的资产路径", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "canvas.inspect",
        ok: true,
        fidelity: "derived",
        nodes: [
          {
            node_id: "n1",
            node_type: "asset",
            name: "猫图",
            position: { x: 0, y: 0 },
            size: { width: 320, height: 240 },
            bbox: { x: 0, y: 0, width: 320, height: 240 },
            group_id: null,
            asset_id: "a1",
            task_id: "t1",
            batch_id: "b1",
            created_at: null,
            prompt_preview: "完整提示词",
            source_file_name: "猫.png",
            asset: {
              asset_id: "a1",
              media_type: "image",
              width: 1024,
              height: 768,
              file_name: "猫.png",
              batch_id: "b1",
              task_id: "t1",
              model_id: "m1",
              prompt_preview: "完整提示词",
              created_at: null,
              local_file_path: "/tmp/proj/media/a1.png",
            },
          },
        ],
        containers: [],
        assets_not_on_canvas: [],
        viewport: null,
        selection: null,
        annotations: [
          {
            annotation_id: "ann-1",
            content: "说明",
            position: { x: 1, y: 2 },
            size: { width: 10, height: 20 },
            bound_to_node_id: "n1",
          },
        ],
        overlaps: [
          { a_id: "g1", b_id: "g2", overlap_width: 140, overlap_height: 44 },
        ],
        min_gap: { a_id: "g1", b_id: "g2", gap: -44 },
      });
    const result = await client.runCliClient(["canvas", "inspect", "--project", "P", "--full"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("注释 1 个");
    expect(result.stdout).toContain("重叠：1 对顶层容器相交");
    expect(result.stdout).toContain("g1 ↔ g2：交叠 140x44");
    expect(result.stdout).toContain("顶层容器最小间距 -44");
    expect(result.stdout).toContain("[文件 /tmp/proj/media/a1.png]");
  });

  it("canvas nodes list 人读 headline：容器从节点总数里单独点出", async () => {
    const node = (nodeId: string, nodeType: string) => ({
      node_id: nodeId,
      node_type: nodeType,
      name: "",
      position: { x: 0, y: 0 },
      group_id: null,
      asset_id: null,
      task_id: null,
    });
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "canvas.nodes.list",
        ok: true,
        nodes: [node("n1", "asset"), node("g1", "group"), node("a1", "agent")],
      });
    const result = await client.runCliClient(["canvas", "nodes", "list", "--project", "P"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("画布节点共 3 个（其中容器 2 个）：");
  });

  it("canvas layout 人读：实际 columns/gap、阅读位次变化明细与伴随/级联计数", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "canvas.layout",
        ok: true,
        positions: { n1: { x: 0, y: 0 }, n2: { x: 0, y: 200 } },
        columns: 2,
        gap: 40,
        content_reordered: true,
        order_changes: [
          { node_id: "n1", from_slot: 2, to_slot: 0 },
          { node_id: "n2", from_slot: 3, to_slot: 1 },
        ],
        summary: { inspected: 2, moved: 4, cascaded: 2, unchanged: 0, skipped: [] },
        operation_id: "op-layout",
        dry_run: false,
      });
    const result = await client.runCliClient(["canvas", "layout", "--project", "P", "--scope", "all"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("按 2 列（间距 40）整理 2 个对象");
    expect(result.stdout).toContain("本次会改变 2 个内容的阅读位次");
    expect(result.stdout).toContain("n1 2→0");
    expect(result.stdout).toContain("其中 2 个为伴随/级联");
    expect(result.stdout).toContain("--operation op-layout");
  });

  // @spec: CLI-030
  it("canvas layout --plan 人读：columns/gap 为 null 时按计划陈述，不出现「null 列」", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "canvas.layout",
        ok: true,
        positions: { n1: { x: 0, y: 0 }, n2: { x: 0, y: 200 } },
        columns: null,
        gap: null,
        plan_applied: true,
        content_reordered: true,
        order_changes: [{ node_id: "n2", from_slot: 1, to_slot: 0 }],
        summary: { inspected: 2, moved: 3, cascaded: 1, unchanged: 0, skipped: [] },
        operation_id: "op-plan",
        dry_run: false,
      });
    const result = await client.runCliClient(["canvas", "layout", "--project", "P", "--plan", "plan.json"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("已按计划整理 2 个节点");
    expect(result.stdout).not.toContain("null 列");
    expect(result.stdout).toContain("其中 1 个为伴随/级联");
    expect(result.stdout).toContain("--operation op-plan");
  });

  // @spec: CLI-030
  it("canvas layout --plan --dry-run 人读：计划，未写入", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "canvas.layout",
        ok: true,
        positions: { n1: { x: 0, y: 0 } },
        columns: null,
        gap: null,
        plan_applied: true,
        content_reordered: false,
        order_changes: [],
        summary: { inspected: 1, moved: 1, unchanged: 0, skipped: [] },
        operation_id: null,
        dry_run: true,
      });
    const result = await client.runCliClient(
      ["canvas", "layout", "--project", "P", "--plan", "plan.json", "--dry-run"],
      { discoveryFilePath, fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("计划，未写入：按计划整理 1 个节点");
  });

  // @spec: CLI-030
  it("canvas layout --plan 人读：没有任何位置变化时如实说明", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "canvas.layout",
        ok: true,
        positions: {},
        columns: null,
        gap: null,
        plan_applied: true,
        content_reordered: false,
        order_changes: [],
        summary: { inspected: 2, moved: 0, unchanged: 2, skipped: [] },
        operation_id: null,
        dry_run: false,
      });
    const result = await client.runCliClient(["canvas", "layout", "--project", "P", "--plan", "plan.json"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("计划未产生任何位置变化");
  });

  it("canvas layout scope=containers 非 pack 人读：按容器占位整理陈述，不误报计划", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "canvas.layout",
        ok: true,
        positions: { c1: { x: 0, y: 0 } },
        columns: null,
        gap: null,
        content_reordered: false,
        order_changes: [],
        summary: { inspected: 2, moved: 1, unchanged: 1, skipped: [] },
        operation_id: "op-containers",
        dry_run: false,
      });
    const result = await client.runCliClient(
      ["canvas", "layout", "--project", "P", "--scope", "containers"],
      { discoveryFilePath, fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("容器间占位整理完成");
    expect(result.stdout).not.toContain("已按计划整理");
  });

  it("canvas nodes move 人读：落点表 + 伴随/级联计数", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "canvas.nodes.move",
        ok: true,
        positions: { n1: { x: 10, y: 20 }, n2: { x: -5, y: 6 } },
        moved_node_ids: ["n1", "n2", "m1"],
        summary: { inspected: 2, moved: 3, cascaded: 1, unchanged: 0, skipped: [] },
        operation_id: "op-move",
        dry_run: false,
      });
    const result = await client.runCliClient(
      ["canvas", "nodes", "move", "--project", "P", "--positions", "n1=10,20", "--positions", "n2=-5,6"],
      { discoveryFilePath, fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("已移动 3 个节点");
    expect(result.stdout).toContain("其中 1 个为伴随/级联");
    expect(result.stdout).toContain("落点：");
    expect(result.stdout).toContain("- n1 @ 10,20");
    expect(result.stdout).toContain("- n2 @ -5,6");
  });
});


// ---------------------------------------------------------------------------
// asset import 人读渲染（fetchImpl 注入固定响应）
// ---------------------------------------------------------------------------

// @spec: CLI-047
describe("cli-client 人读渲染 asset import（fetchImpl 注入）", () => {
  const client = loadClientModule();
  const tempRoot = join(tmpdir(), `cli-client-import-${process.pid}`);
  const discoveryFilePath = join(tempRoot, "cli-runtime.json");

  beforeAll(() => {
    mkdirSync(tempRoot, { recursive: true });
    writeDiscoveryFile(discoveryFilePath, {
      port: 59999,
      token: "unused-injected-fetch",
      pid: process.pid,
      version: "test-1.0.0",
      startedAt: new Date().toISOString(),
    });
  });

  it("人读：逐文件输出文件名/媒体类型/资产标识/节点标识，不倾倒原始 JSON", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "asset.import",
        ok: true,
        imported: [
          { file_name: "a.png", asset_id: "asset-1", node_id: "node-1", media_type: "image" },
          { file_name: "b.mp4", asset_id: "asset-2", node_id: "node-2", media_type: "video" },
        ],
      });
    const result = await client.runCliClient(
      ["asset", "import", "--project", "P", "--file", "/tmp/a.png", "--file", "/tmp/b.mp4"],
      { discoveryFilePath, fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("已导入 2 个文件");
    expect(result.stdout).toContain("a.png（image）：资产 asset-1，画布节点 node-1");
    expect(result.stdout).toContain("b.mp4（video）：资产 asset-2，画布节点 node-2");
    // 人读输出不是 JSON dump
    expect(result.stdout).not.toContain('"file_name"');
    expect(result.stdout).not.toContain("[{");
  });

  it("人读：画布窗口侧前置校验错误（file_not_found）原样透传，退出码 1", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "asset.import",
        ok: false,
        error: { code: "file_not_found", message: "找不到文件：/tmp/ghost.png" },
      });
    const result = await client.runCliClient(
      ["asset", "import", "--project", "P", "--file", "/tmp/ghost.png"],
      { discoveryFilePath, fetchImpl },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("找不到文件：/tmp/ghost.png");
  });
});

// @spec: CLI-057
describe("cli-client 人读渲染 画布清单/重命名/建组（fetchImpl 注入）", () => {
  const client = loadClientModule();
  const tempRoot = join(tmpdir(), `cli-client-canvas-human-${process.pid}`);
  const discoveryFilePath = join(tempRoot, "cli-runtime.json");

  beforeAll(() => {
    mkdirSync(tempRoot, { recursive: true });
    writeDiscoveryFile(discoveryFilePath, {
      port: 59999,
      token: "unused-injected-fetch",
      pid: process.pid,
      version: "test-1.0.0",
      startedAt: new Date().toISOString(),
    });
  });

  it("canvas nodes list 人读：node_id 类型 名称 @x,y，组与资产引用以方括号后缀", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "canvas.nodes.list",
        ok: true,
        nodes: [
          {
            node_id: "n1",
            node_type: "asset",
            name: "首图",
            position: { x: 10, y: 20 },
            group_id: "g1",
            asset_id: "asset-1",
            task_id: null,
          },
          {
            node_id: "n2",
            node_type: "textInput",
            name: "",
            position: { x: -5, y: 6.5 },
            group_id: null,
            asset_id: null,
            task_id: null,
          },
        ],
      });
    const result = await client.runCliClient(["canvas", "nodes", "list", "--project", "P"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("- n1 asset 首图 @ 10,20 [组 g1] [资产 asset-1]");
    expect(result.stdout).toContain("- n2 textInput （未命名） @ -5,6.5");
  });

  it("canvas nodes list 人读：空画布输出明确空态", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ command: "canvas.nodes.list", ok: true, nodes: [] });
    const result = await client.runCliClient(["canvas", "nodes", "list", "--project", "P"], {
      discoveryFilePath,
      fetchImpl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("画布上还没有任何节点。");
  });

  it("canvas group rename 人读：已重命名组 X → Y", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        command: "canvas.group.rename",
        ok: true,
        group_node_id: "g1",
        name: "新组名",
        operation_id: null,
      });
    const result = await client.runCliClient(
      ["canvas", "group", "rename", "--project", "P", "--group", "g1", "--name", "新组名"],
      { discoveryFilePath, fetchImpl },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("已重命名组 g1 → 新组名");
  });

  it("canvas group create 人读：打印纳入成员数（空组为 0）", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call += 1;
      return jsonResponse({
        command: "canvas.group.create",
        ok: true,
        group_node_id: call === 1 ? "g1" : "g2",
        member_ids: call === 1 ? ["n1", "n2"] : [],
        operation_id: "op-create",
      });
    };
    const withMembers = await client.runCliClient(
      ["canvas", "group", "create", "--project", "P", "--name", "组", "--members", "n1,n2"],
      { discoveryFilePath, fetchImpl },
    );
    expect(withMembers.exitCode).toBe(0);
    expect(withMembers.stdout).toContain("已创建组 g1，纳入成员 2 个");

    const empty = await client.runCliClient(
      ["canvas", "group", "create", "--project", "P", "--name", "空组"],
      { discoveryFilePath, fetchImpl },
    );
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("已创建组 g2，纳入成员 0 个");
  });
});
