import * as crypto from "node:crypto";
import {
  CliProxyCommandResponseSchema,
  CliProxyCommandSchema,
  type CliProxyCommand,
  type CliProxyCommandResponse,
} from "@iart/contracts";

/**
 * CLI 代理执行通道分发端（spec docs/integrations/CLI与本地Agent集成.md §6.3，Main 侧）。
 *
 * 职责：把一条画布命令交给目标项目的画布窗口执行，并按 request_id 配对原路响应。
 * - 请求-响应形态：每条命令携带唯一 request_id；画布窗口执行完毕原路返回结果或错误。
 * - 通道不设超时（仓库纪律：内部通信不设超时时长，spec §6.3）：画布窗口无响应时命令挂起；
 *   窗口销毁事件是通道终结（以结构化失败拒绝该窗口关联的挂起命令），不是超时。
 * - request_id 不匹配/无配对的响应丢弃并 debug 留痕（条件跳过必须留痕）。
 * - 重复 request_id 防御：pending 已有同 id（不应发生）拒绝本次分发。
 *
 * Electron 解耦（可测性）：窗口发送面注入，本模块不经 Electron；响应回传载荷经
 * consumeResponsePayload 入口进入（生产由 desktop-shell-ipc 的 ipcMain.on 转发，测试直接
 * 调用模拟）。通道名常量与载荷 schema 均以 packages/contracts 为唯一事实源。
 */

/** 分发入参：不带 request_id 的代理命令候选（request_id 由分发器生成并合入）。 */
type DistributiveOmit<TValue, TKey extends PropertyKey> = TValue extends unknown ? Omit<TValue, TKey> : never;
export type CliProxyCommandCandidate = DistributiveOmit<CliProxyCommand, "request_id">;

/** 画布窗口的发送面抽象（生产适配 BrowserWindow.webContents）。 */
export interface CliProxyDispatcherWindow {
  /** 发送命令载荷（主进程 → 画布窗口，CLI_PROXY_REQUEST_CHANNEL）。 */
  sendCommand: (payload: unknown) => void;
  /** 登记窗口销毁监听（通道终结清理触发；生产适配 BrowserWindow once("closed")）。 */
  onClosed: (listener: () => void) => void;
}

export interface CliProxyDispatcherDeps {
  /** 按项目路径取画布窗口发送面；窗口不存在或已销毁返回 null。 */
  getWindow: (projectPath: string) => CliProxyDispatcherWindow | null;
  /** request_id 生成器；缺省 crypto.randomUUID（测试注入固定值验证重复防御）。 */
  newRequestId?: () => string;
}

export type CliProxyDispatchOutcome =
  | { ok: true; response: CliProxyCommandResponse }
  | {
      ok: false;
      /** no_window：窗口不存在/已销毁（含挂起期间窗口关闭的通道终结）。 */
      reason: "no_window" | "invalid_command" | "duplicate_request_id";
      /** 诊断线索（进 debug 日志与上游错误 message）。 */
      detail: string;
    };

export interface CliProxyDispatcher {
  /** 分发一条代理命令并等待原路响应；不设超时（挂起由窗口销毁终结或响应配对解除）。 */
  dispatch: (projectPath: string, candidate: CliProxyCommandCandidate) => Promise<CliProxyDispatchOutcome>;
  /** 响应通道载荷入口（desktop-shell-ipc 的 ipcMain.on 转发至此配对 pending）。 */
  consumeResponsePayload: (payload: unknown) => void;
}

interface CliProxyPendingEntry {
  request_id: string;
  command: CliProxyCommand["command"];
  settled: boolean;
  resolve: (response: CliProxyCommandResponse) => void;
}

export const createCliProxyDispatcher = (deps: CliProxyDispatcherDeps): CliProxyDispatcher => {
  const pending = new Map<string, CliProxyPendingEntry>();
  const newRequestId = deps.newRequestId ?? (() => crypto.randomUUID());

  const settleEntry = (entry: CliProxyPendingEntry, response: CliProxyCommandResponse): void => {
    if (entry.settled) return;
    entry.settled = true;
    pending.delete(entry.request_id);
    entry.resolve(response);
  };

  // 响应入口 consumeResponsePayload 由 IPC 注册层转发调用（desktop-shell-ipc 的
  // ipcMain.on(CLI_PROXY_RESPONSE_CHANNEL) → bootstrap 闭包 → 此处）：载荷先过契约
  // schema，再按 request_id 配对 pending。
  const consumeResponsePayload = (raw: unknown): void => {
    const parsed = CliProxyCommandResponseSchema.safeParse(raw);
    if (!parsed.success) {
      console.debug("[cli-proxy-dispatch] 响应载荷未通过契约校验，丢弃", {
        issues: parsed.error.issues.length,
      });
      return;
    }
    const response = parsed.data;
    const entry = pending.get(response.request_id);
    if (entry === undefined) {
      console.debug("[cli-proxy-dispatch] 响应 request_id 无配对挂起命令，丢弃", {
        request_id: response.request_id,
        command: response.command,
      });
      return;
    }
    console.debug("[cli-proxy-dispatch] 响应配对成功", {
      request_id: response.request_id,
      command: response.command,
      ok: !("error" in response),
    });
    settleEntry(entry, response);
  };

  const dispatch = (
    projectPath: string,
    candidate: CliProxyCommandCandidate,
  ): Promise<CliProxyDispatchOutcome> => {
    const requestId = newRequestId();
    if (pending.has(requestId)) {
      // 防御分支（不应发生）：request_id 碰撞时拒绝本次分发，不覆盖既有 pending。
      console.debug("[cli-proxy-dispatch] 重复 request_id，拒绝本次分发", { request_id: requestId });
      return Promise.resolve({
        ok: false,
        reason: "duplicate_request_id",
        detail: `duplicate request_id: ${requestId}`,
      });
    }
    // 合入 request_id 后整体再过一次命令契约（执行器侧参数在契约层已校验，此处兜整体形状）。
    const parsed = CliProxyCommandSchema.safeParse({ ...candidate, request_id: requestId });
    if (!parsed.success) {
      console.debug("[cli-proxy-dispatch] 命令候选未通过契约校验，拒绝分发", {
        command: candidate.command,
        issues: parsed.error.issues.length,
      });
      return Promise.resolve({
        ok: false,
        reason: "invalid_command",
        detail: parsed.error.message.slice(0, 200),
      });
    }
    const win = deps.getWindow(projectPath);
    if (win === null) {
      console.debug("[cli-proxy-dispatch] 目标项目无存活画布窗口，跳过分发", { projectPath });
      return Promise.resolve({ ok: false, reason: "no_window", detail: "no canvas window for project" });
    }
    const command = parsed.data;
    return new Promise<CliProxyDispatchOutcome>((resolve) => {
      const entry: CliProxyPendingEntry = {
        request_id: requestId,
        command: command.command,
        settled: false,
        resolve: (response) => {
          entry.settled = true;
          resolve({ ok: true, response });
        },
      };
      pending.set(requestId, entry);
      // 窗口销毁是通道终结（非超时）：该窗口关联的挂起命令以结构化失败拒绝。
      win.onClosed(() => {
        if (entry.settled) return;
        entry.settled = true;
        pending.delete(requestId);
        console.debug("[cli-proxy-dispatch] 画布窗口已关闭，拒绝挂起中的代理命令", {
          request_id: requestId,
          command: command.command,
        });
        resolve({ ok: false, reason: "no_window", detail: "画布窗口已关闭" });
      });
      win.sendCommand(command);
      console.debug("[cli-proxy-dispatch] 命令已发往画布窗口", {
        request_id: requestId,
        command: command.command,
      });
    });
  };

  return {
    dispatch,
    consumeResponsePayload,
  };
};