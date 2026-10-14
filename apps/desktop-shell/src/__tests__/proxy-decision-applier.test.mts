// @vitest-environment node
// @spec: PROXY-002, PROXY-003
//
// 生效代理决策应用测试（spec docs/runtime/远端请求执行治理原则.md「代理治理」）：
// 档位 → session.setProxy 配置映射（direct / manual / system）、双 session 同配置应用、
// 目标缺失与 setProxy 失败留痕、手动档凭据提取；installer 下载改经注入 fetcher
// （PROXY-003：传输入口可注入，生产由 IPC 层接 net.fetch，session 级代理生效由真机点验）。

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const applierEntry = `${workspaceRoot}/apps/desktop-shell/dist/proxy/proxy-decision-applier.cjs`;
const installerEntry = `${workspaceRoot}/apps/desktop-shell/dist/skill-store/skill-store-installer.cjs`;

type SessionProxyConfig = { mode: string; proxyRules?: string };
type FakeSession = {
  setProxy: (config: SessionProxyConfig) => Promise<void>;
  calls: SessionProxyConfig[];
  failWith?: Error;
};
type Decision = { mode: string; proxyUrl?: string; resolved?: { kind: string; proxyUrl?: string } };

type ApplierModule = {
  UPDATER_SESSION_PARTITION: string;
  buildSessionProxyConfig: (decision: Decision) => SessionProxyConfig;
  extractProxyCredentials: (decision: Decision | null) => { username: string; password: string } | null;
  createProxyDecisionApplier: (deps: {
    getProxySessionTargets: () => Array<{ setProxy: (config: SessionProxyConfig) => Promise<void> } | null | undefined>;
    log?: (level: "info" | "warn", message: string, meta?: Record<string, unknown>) => void;
  }) => {
    apply: (decision: Decision) => Promise<void>;
    getLatestDecision: () => Decision | null;
  };
};

const makeFakeSession = (failWith?: Error): FakeSession => {
  const session: FakeSession = {
    calls: [],
    failWith,
    setProxy: async (config) => {
      if (session.failWith) throw session.failWith;
      session.calls.push(config);
    },
  };
  return session;
};

const applierMod = requireDesktop(applierEntry) as ApplierModule;

describe("buildSessionProxyConfig：档位 → session 代理配置映射（PROXY-002）", () => {
  it("direct 档映射 mode direct", () => {
    expect(applierMod.buildSessionProxyConfig({ mode: "direct" })).toEqual({ mode: "direct" });
  });

  it("manual 档映射 fixed_servers + host:port（剥 scheme）", () => {
    expect(
      applierMod.buildSessionProxyConfig({ mode: "manual", proxyUrl: "http://127.0.0.1:7890/" }),
    ).toEqual({ mode: "fixed_servers", proxyRules: "127.0.0.1:7890" });
    expect(
      applierMod.buildSessionProxyConfig({ mode: "manual", proxyUrl: "https://proxy.example.com/" }),
    ).toEqual({ mode: "fixed_servers", proxyRules: "proxy.example.com:443" });
  });

  it("system 档映射 Chromium 原生跟随（mode system，实时）", () => {
    expect(
      applierMod.buildSessionProxyConfig({ mode: "system", resolved: { kind: "proxy", proxyUrl: "http://x:1" } }),
    ).toEqual({ mode: "system" });
    expect(
      applierMod.buildSessionProxyConfig({ mode: "system", resolved: { kind: "none" } }),
    ).toEqual({ mode: "system" });
  });
});

describe("createProxyDecisionApplier：双 session 同配置应用（PROXY-002）", () => {
  it("决策同时应用到默认与更新器两个 session", async () => {
    const defaultSession = makeFakeSession();
    const updaterSession = makeFakeSession();
    const applier = applierMod.createProxyDecisionApplier({
      getProxySessionTargets: () => [defaultSession, updaterSession],
    });
    await applier.apply({ mode: "manual", proxyUrl: "http://127.0.0.1:7890/" });
    expect(defaultSession.calls).toEqual([{ mode: "fixed_servers", proxyRules: "127.0.0.1:7890" }]);
    expect(updaterSession.calls).toEqual([{ mode: "fixed_servers", proxyRules: "127.0.0.1:7890" }]);
    expect(applier.getLatestDecision()).toEqual({ mode: "manual", proxyUrl: "http://127.0.0.1:7890/" });
  });

  it("目标缺失留痕不崩溃；setProxy 拒绝留痕不崩溃", async () => {
    const warnings: string[] = [];
    const failing = makeFakeSession(new Error("boom"));
    const applier = applierMod.createProxyDecisionApplier({
      getProxySessionTargets: () => [null, failing],
      log: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
    });
    await applier.apply({ mode: "direct" });
    expect(failing.calls).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(applier.getLatestDecision()).toEqual({ mode: "direct" });
  });
});

describe("extractProxyCredentials：手动档凭据（login 事件供凭据）", () => {
  it("user:pass 形态解码返回；无凭据与非 manual 档返回 null", () => {
    expect(
      applierMod.extractProxyCredentials({ mode: "manual", proxyUrl: "http://user:p%40ss@127.0.0.1:7890/" }),
    ).toEqual({ username: "user", password: "p@ss" });
    expect(applierMod.extractProxyCredentials({ mode: "manual", proxyUrl: "http://127.0.0.1:7890/" })).toBeNull();
    expect(applierMod.extractProxyCredentials({ mode: "direct" })).toBeNull();
    expect(applierMod.extractProxyCredentials(null)).toBeNull();
  });
});

describe("skill bundle 下载经注入 fetcher（PROXY-003 传输入口）", () => {
  type InstallerModule = {
    __test_only__: {
      downloadBundleJson: (
        url: string,
        sha512: string,
        fetchBundle: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>,
      ) => Promise<string>;
    };
  };
  const installerMod = requireDesktop(installerEntry) as InstallerModule;
  const download = installerMod.__test_only__.downloadBundleJson;

  const sha512Of = async (text: string): Promise<string> => {
    const { createHash } = await import("node:crypto");
    return createHash("sha512").update(Buffer.from(text, "utf8")).digest("hex");
  };

  it("200 + sha512 匹配 → 返回 body 字符串", async () => {
    const body = '{"id":"demo"}';
    const fetchCalls: string[] = [];
    const result = await download(
      "https://example.invalid/bundle.json",
      await sha512Of(body),
      (url) => {
        fetchCalls.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(Buffer.from(body, "utf8")),
        });
      },
    );
    expect(result).toBe(body);
    expect(fetchCalls).toEqual(["https://example.invalid/bundle.json"]);
  });

  it("非 2xx / sha512 不匹配 / fetcher 抛错 → 报错且信息可定位", async () => {
    await expect(download("https://example.invalid/b", "x", () =>
      Promise.resolve({ ok: false, status: 404, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }),
    )).rejects.toThrow("HTTP 404");

    await expect(download("https://example.invalid/b", "deadbeef", () =>
      Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(Buffer.from("{}", "utf8")) }),
    )).rejects.toThrow("sha512 mismatch");

    await expect(download("https://example.invalid/b", "x", () =>
      Promise.reject(new Error("ECONNREFUSED")),
    )).rejects.toThrow("bundle 请求失败");
  });
});
