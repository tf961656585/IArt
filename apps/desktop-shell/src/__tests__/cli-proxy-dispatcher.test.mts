// @vitest-environment node
// @spec: CLI-014, CLI-007
//
// 代理执行通道分发端测试（spec docs/integrations/CLI与本地Agent集成.md §6.3）：
// request_id 合入与契约校验、pending 按 request_id 配对 resolve、无配对/非法响应丢弃留痕、
// 窗口销毁终结挂起命令（通道终结非超时）、无窗口结构化失败、重复 request_id 防御。
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { CliProxyCommandResponseSchema, CliProxyCommandSchema } from "@iart/contracts";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const dispatcherEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-proxy-dispatcher.cjs`;

type DispatcherModule = {
  createCliProxyDispatcher: (deps: {
    getWindow: (projectPath: string) => {
      sendCommand: (payload: unknown) => void;
      onClosed: (listener: () => void) => void;
    } | null;
    newRequestId?: () => string;
  }) => {
    dispatch: (projectPath: string, candidate: unknown) => Promise<
      { ok: true; response: unknown } | { ok: false; reason: string; detail: string }
    >;
    consumeResponsePayload: (payload: unknown) => void;
  };
};

const loadDispatcherModule = (): DispatcherModule => requireDesktop(dispatcherEntry) as DispatcherModule;

/** 窗口假实现：捕获发送载荷与销毁监听。 */
const makeFakeWindow = () => {
  const sent: unknown[] = [];
  const closedListeners: Array<() => void> = [];
  return {
    sent,
    closedListeners,
    handle: {
      sendCommand: (payload: unknown) => {
        sent.push(payload);
      },
      onClosed: (listener: () => void) => {
        closedListeners.push(listener);
      },
    },
    close: () => {
      for (const listener of closedListeners) listener();
    },
  };
};

/** 分发器假装配：getWindow 可控、响应经 consumeResponsePayload 直喂。 */
const makeHarness = (options: { window: ReturnType<typeof makeFakeWindow> | null; newRequestId?: () => string }) => {
  const mod = loadDispatcherModule();
  const dispatcher = mod.createCliProxyDispatcher({
    getWindow: () => (options.window !== null ? options.window.handle : null),
    ...(options.newRequestId !== undefined ? { newRequestId: options.newRequestId } : {}),
  });
  return dispatcher;
};

describe("cli-proxy-dispatcher 代理分发端（spec §6.3）", () => {
  it("分发合入 request_id 且载荷过契约校验，响应按 request_id 配对 resolve（原路返回）", async () => {
    const win = makeFakeWindow();
    const dispatcher = makeHarness({ window: win });
    const pending = dispatcher.dispatch("/tmp/project-a", {
      command: "canvas.group.create",
      name: "角色组",
      members: ["node-1"],
    });
    expect(win.sent).toHaveLength(1);
    const sentPayload = win.sent[0];
    const parsedCommand = CliProxyCommandSchema.parse(sentPayload);
    expect(parsedCommand.command).toBe("canvas.group.create");
    expect(parsedCommand.request_id.length).toBeGreaterThan(0);

    // 画布窗口原路返回（结果形状）
    dispatcher.consumeResponsePayload({
      command: "canvas.group.create",
      request_id: parsedCommand.request_id,
      group_node_id: "group-1",
    });
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unexpected failure");
    const response = CliProxyCommandResponseSchema.parse(outcome.response);
    if (!("group_node_id" in response)) throw new Error("unexpected response variant");
    expect(response.group_node_id).toBe("group-1");
  });

  it("request_id 不匹配的响应丢弃并 debug 留痕，pending 继续等待配对响应", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      const win = makeFakeWindow();
      const dispatcher = makeHarness({ window: win });
      const pending = dispatcher.dispatch("/tmp/project-a", { command: "canvas.layout", scope: "all" });
      const sentPayload = CliProxyCommandSchema.parse(win.sent[0]);

      // 无配对的响应：丢弃 + 留痕
      dispatcher.consumeResponsePayload({
        command: "canvas.layout",
        request_id: "not-the-one",
        positions: {},
      });
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("无配对挂起命令"),
        expect.objectContaining({ request_id: "not-the-one" }),
      );

      // pending 未被误 resolve：配对响应到达后才 settle
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      dispatcher.consumeResponsePayload({
        command: "canvas.layout",
        request_id: sentPayload.request_id,
        positions: { n1: { x: 1, y: 2 } },
      });
      const outcome = await pending;
      expect(outcome.ok).toBe(true);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("响应载荷未通过契约校验时丢弃并留痕", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      const win = makeFakeWindow();
      const dispatcher = makeHarness({ window: win });
      const pending = dispatcher.dispatch("/tmp/project-a", { command: "canvas.layout", scope: "all" });
      dispatcher.consumeResponsePayload({ command: "canvas.layout", request_id: "whatever", positions: "not-a-record" });
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("未通过契约校验"), expect.anything());

      const sentPayload = CliProxyCommandSchema.parse(win.sent[0]);
      dispatcher.consumeResponsePayload({
        command: "canvas.layout",
        request_id: sentPayload.request_id,
        positions: {},
      });
      const outcome = await pending;
      expect(outcome.ok).toBe(true);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("窗口销毁终结挂起命令（通道终结非超时）：结构化拒绝且后续迟到响应不再 settle", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      const win = makeFakeWindow();
      const dispatcher = makeHarness({ window: win });
      const pending = dispatcher.dispatch("/tmp/project-a", { command: "generate", prompt: "p", model: "m" });
      const sentPayload = CliProxyCommandSchema.parse(win.sent[0]);

      win.close();
      const outcome = await pending;
      expect(outcome).toMatchObject({ ok: false, reason: "no_window", detail: "画布窗口已关闭" });
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("画布窗口已关闭"),
        expect.objectContaining({ request_id: sentPayload.request_id }),
      );

      // 迟到的响应：pending 已清，丢弃留痕，不产生二次 settle
      dispatcher.consumeResponsePayload({
        command: "generate",
        request_id: sentPayload.request_id,
        batch_id: "b1",
        tasks: [{ task_id: "t-1", task_index: 0, node_id: null, group_id: null }],
      });
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("无配对挂起命令"),
        expect.objectContaining({ request_id: sentPayload.request_id }),
      );
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("无窗口分发返回结构化失败（no_window），不发送载荷", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      const dispatcher = makeHarness({ window: null });
      const outcome = await dispatcher.dispatch("/tmp/project-a", { command: "canvas.layout", scope: "all" });
      expect(outcome).toMatchObject({ ok: false, reason: "no_window" });
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("无存活画布窗口"), expect.anything());
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("命令候选未通过契约校验返回 invalid_command，不触达窗口", async () => {
    const win = makeFakeWindow();
    const dispatcher = makeHarness({ window: win });
    const outcome = await dispatcher.dispatch("/tmp/project-a", {
      // 故意注入非法候选（缺 members）：测试不经类型检查，运行期由契约 parse 拒绝
      command: "canvas.group.create",
      name: "g",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_command" });
    expect(win.sent).toHaveLength(0);
  });

  it("重复 request_id 防御：pending 已持有同 id 时拒绝本次分发", async () => {
    const win = makeFakeWindow();
    let callCount = 0;
    const dispatcher = makeHarness({
      window: win,
      newRequestId: () => {
        callCount += 1;
        return "fixed-request-id";
      },
    });
    const first = dispatcher.dispatch("/tmp/project-a", { command: "canvas.layout", scope: "all" });
    const second = await dispatcher.dispatch("/tmp/project-b", { command: "canvas.layout", scope: "all" });
    expect(second).toMatchObject({ ok: false, reason: "duplicate_request_id" });
    // 第一条命令仍持有 pending：只有一次发送
    expect(win.sent).toHaveLength(1);
    expect(callCount).toBe(2);

    const sentPayload = CliProxyCommandSchema.parse(win.sent[0]);
    dispatcher.consumeResponsePayload({
      command: "canvas.layout",
      request_id: sentPayload.request_id,
      positions: {},
    });
    expect((await first).ok).toBe(true);
  });

  it("不设超时：无响应时分发挂起不 resolve（内部通信纪律）", async () => {
    const win = makeFakeWindow();
    const dispatcher = makeHarness({ window: win });
    const pending = dispatcher.dispatch("/tmp/project-a", { command: "canvas.layout", scope: "all" });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    // 清理：终结挂起避免悬挂 promise
    win.close();
    await pending;
  });
});
