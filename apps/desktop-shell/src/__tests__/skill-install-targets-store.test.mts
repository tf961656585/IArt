// @vitest-environment node
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 被测对象是编译产物（dist/*.cjs），与 skill-store-installer.test.mts 同一装载方式。
const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const storeEntry = `${workspaceRoot}/apps/desktop-shell/dist/skill-store/skill-install-targets-store.cjs`;
const installerEntry = `${workspaceRoot}/apps/desktop-shell/dist/skill-store/skill-store-installer.cjs`;

type CustomTarget = { id: string; name: string; skillsDir: string };
type MutationResult =
  | { ok: true; target: CustomTarget }
  | { ok: false; error: string };
type RemovalResult = { ok: true } | { ok: false; error: string };

type StoreModule = {
  listCustomSkillInstallTargets: () => CustomTarget[];
  addCustomSkillInstallTarget: (input: { name: string; dir: string }) => MutationResult;
  updateCustomSkillInstallTarget: (input: { id: string; name: string }) => MutationResult;
  removeCustomSkillInstallTarget: (input: { id: string }) => RemovalResult;
  __test_only__: {
    getRegistryFilePath: () => string;
    readRegistryFile: () => CustomTarget[];
    writeRegistryFile: (targets: CustomTarget[]) => void;
    isBuiltinTargetId: (id: string) => boolean;
    resolveBuiltinTargetSkillsDir: (target: "agents" | "claude") => string;
    getAppOwnDataDirs: () => string[];
  };
};

type InstallerModule = {
  installSkill: (request: {
    bundleUrl: string;
    sha512: string;
    target: string;
    skillId: string;
  }) => Promise<{ ok: true; installedPath: string } | { ok: false; error: string }>;
  getInstalledSkillState: () => {
    skills: Array<{ skillId: string; version: string; target: string }>;
  };
  __test_only__: {
    resolveTargetSkillsDir: (target: string) => string | null;
  };
};

const loadStore = (): StoreModule => requireDesktop(storeEntry) as StoreModule;
const loadInstaller = (): InstallerModule => requireDesktop(installerEntry) as InstallerModule;

// 启动 mock bundle server，返回 bundle JSON 与其 sha512（与 skill-store-installer.test.mts 一致）。
const startBundleServer = (
  bundleJson: string,
): Promise<{
  server: http.Server;
  url: string;
  sha512: string;
  close: () => Promise<void>;
}> => {
  return new Promise((resolve) => {
    const sha512 = crypto.createHash("sha512").update(bundleJson, "utf8").digest("hex");
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(bundleJson);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        throw new Error("bundle_server_address_unavailable");
      }
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/bundle.json`,
        sha512,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
};

const buildBundle = (id: string, version: string): string =>
  JSON.stringify({
    id,
    version,
    files: [
      {
        path: "skill.json",
        content: JSON.stringify({ id, version, name: "T", description: "d" }),
        executable: false,
      },
      { path: "SKILL.md", content: "# test", executable: false },
    ],
  });

describe("skill-install-targets-store + installer（自定义安装目标）", () => {
  let store: StoreModule;
  let installer: InstallerModule;
  let fakeHome: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    store = loadStore();
    installer = loadInstaller();
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "skill-targets-home-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  const registryPath = (): string => store.__test_only__.getRegistryFilePath();
  const appOwnDirs = (): string[] => store.__test_only__.getAppOwnDataDirs();

  describe("addCustomSkillInstallTarget", () => {
    it("成功登记：id 前缀 custom-、目录归一去尾分隔符、目录被创建、文件落盘", () => {
      const dir = path.join(fakeHome, "my-tools", "skills") + path.sep;
      const result = store.addCustomSkillInstallTarget({ name: "  我的工具  ", dir });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.target.id).toMatch(/^custom-[0-9a-f]{8}$/);
      expect(result.target.name).toBe("我的工具");
      expect(result.target.skillsDir).toBe(path.join(fakeHome, "my-tools", "skills"));
      expect(fs.existsSync(result.target.skillsDir)).toBe(true);

      const raw = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as unknown;
      expect(raw).toEqual({ version: 1, targets: [result.target] });
      // 原子写不留临时文件
      expect(fs.existsSync(`${registryPath()}.tmp.${process.pid}`)).toBe(false);
    });

    it("与内置目标目录相同 → duplicate-dir", () => {
      const result = store.addCustomSkillInstallTarget({
        name: "agents",
        dir: path.join(fakeHome, ".agents", "skills"),
      });
      expect(result).toEqual({ ok: false, error: "duplicate-dir" });
    });

    it("与既有自定义目录相同 → duplicate-dir", () => {
      const dir = path.join(fakeHome, "dup", "skills");
      expect(store.addCustomSkillInstallTarget({ name: "a", dir }).ok).toBe(true);
      expect(store.addCustomSkillInstallTarget({ name: "b", dir })).toEqual({
        ok: false,
        error: "duplicate-dir",
      });
    });

    it("候选目录是既有目录的后代 → nested-dir（含内置目录）", () => {
      const parent = path.join(fakeHome, "nest", "skills");
      expect(store.addCustomSkillInstallTarget({ name: "parent", dir: parent }).ok).toBe(true);

      expect(
        store.addCustomSkillInstallTarget({ name: "child", dir: path.join(parent, "sub") }),
      ).toEqual({ ok: false, error: "nested-dir" });
      expect(
        store.addCustomSkillInstallTarget({
          name: "builtin-child",
          dir: path.join(fakeHome, ".agents", "skills", "sub"),
        }),
      ).toEqual({ ok: false, error: "nested-dir" });
    });

    it("候选目录是既有目录的祖先 → nested-dir（含内置目录）", () => {
      expect(store.addCustomSkillInstallTarget({ name: "child", dir: path.join(fakeHome, "nest", "skills") }).ok).toBe(true);
      expect(store.addCustomSkillInstallTarget({ name: "parent", dir: path.join(fakeHome, "nest") })).toEqual({
        ok: false,
        error: "nested-dir",
      });
      // ~/.agents 是 ~/.agents/skills 的祖先
      expect(
        store.addCustomSkillInstallTarget({ name: "agents-root", dir: path.join(fakeHome, ".agents") }),
      ).toEqual({ ok: false, error: "nested-dir" });
    });

    it("落在 app 自有数据目录（dev 与 prod 两个变体）之内或就是它 → reserved-dir", () => {
      for (const appDataDir of appOwnDirs()) {
        expect(store.addCustomSkillInstallTarget({ name: "self", dir: appDataDir })).toEqual({
          ok: false,
          error: "reserved-dir",
        });
        expect(
          store.addCustomSkillInstallTarget({ name: "inside", dir: path.join(appDataDir, "sub") }),
        ).toEqual({ ok: false, error: "reserved-dir" });
      }
    });

    it("name 空白 → invalid-request；相对路径 → invalid-request", () => {
      expect(store.addCustomSkillInstallTarget({ name: "   ", dir: "/tmp/x" })).toEqual({
        ok: false,
        error: "invalid-request",
      });
      expect(store.addCustomSkillInstallTarget({ name: "n", dir: "relative/dir" })).toEqual({
        ok: false,
        error: "invalid-request",
      });
    });
  });

  describe("updateCustomSkillInstallTarget", () => {
    it("改名成功并落盘", () => {
      const added = store.addCustomSkillInstallTarget({ name: "old", dir: path.join(fakeHome, "u", "skills") });
      if (!added.ok) throw new Error("setup failed");
      const result = store.updateCustomSkillInstallTarget({ id: added.target.id, name: "new-name" });
      expect(result).toEqual({
        ok: true,
        target: { id: added.target.id, name: "new-name", skillsDir: added.target.skillsDir },
      });
      expect(store.listCustomSkillInstallTargets()).toEqual([result.ok ? result.target : null]);
    });

    it("id 不在注册表 → not-found", () => {
      expect(store.updateCustomSkillInstallTarget({ id: "custom-ffffffff", name: "x" })).toEqual({
        ok: false,
        error: "not-found",
      });
    });

    it("内置 id（agents/claude）视同 not-found", () => {
      expect(store.updateCustomSkillInstallTarget({ id: "agents", name: "x" })).toEqual({
        ok: false,
        error: "not-found",
      });
      expect(store.updateCustomSkillInstallTarget({ id: "claude", name: "x" })).toEqual({
        ok: false,
        error: "not-found",
      });
    });
  });

  describe("removeCustomSkillInstallTarget", () => {
    it("移除条目但绝不触碰磁盘上的 skill 文件", () => {
      const added = store.addCustomSkillInstallTarget({ name: "r", dir: path.join(fakeHome, "r", "skills") });
      if (!added.ok) throw new Error("setup failed");
      const skillFile = path.join(added.target.skillsDir, "my-skill", "SKILL.md");
      fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      fs.writeFileSync(skillFile, "user data");

      expect(store.removeCustomSkillInstallTarget({ id: added.target.id })).toEqual({ ok: true });
      expect(store.listCustomSkillInstallTargets()).toEqual([]);
      // 磁盘文件原样保留
      expect(fs.readFileSync(skillFile, "utf8")).toBe("user data");
    });

    it("id 不在注册表 → not-found；内置 id 视同 not-found", () => {
      expect(store.removeCustomSkillInstallTarget({ id: "custom-ffffffff" })).toEqual({
        ok: false,
        error: "not-found",
      });
      expect(store.removeCustomSkillInstallTarget({ id: "agents" })).toEqual({
        ok: false,
        error: "not-found",
      });
    });
  });

  describe("注册表文件读取守卫", () => {
    it("损坏文件按空注册表处理且不阻塞后续写覆盖", () => {
      fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
      fs.writeFileSync(registryPath(), "{ not valid json", "utf8");
      expect(store.listCustomSkillInstallTargets()).toEqual([]);

      const added = store.addCustomSkillInstallTarget({ name: "after", dir: path.join(fakeHome, "a", "skills") });
      expect(added.ok).toBe(true);
      expect(store.listCustomSkillInstallTargets()).toHaveLength(1);
    });

    it("版本不识别按空处理；targets 非数组按空处理", () => {
      fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
      fs.writeFileSync(registryPath(), JSON.stringify({ version: 2, targets: [] }), "utf8");
      expect(store.listCustomSkillInstallTargets()).toEqual([]);

      fs.writeFileSync(registryPath(), JSON.stringify({ version: 1, targets: "nope" }), "utf8");
      expect(store.listCustomSkillInstallTargets()).toEqual([]);
    });

    it("非法条目逐条丢弃，合法条目保留", () => {
      const valid = { id: "custom-0a1b2c3d", name: "ok", skillsDir: path.join(fakeHome, "v", "skills") };
      fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
      fs.writeFileSync(
        registryPath(),
        JSON.stringify({
          version: 1,
          targets: [valid, { id: "custom-bad", name: "", skillsDir: "/x" }, "not-an-object"],
        }),
        "utf8",
      );
      expect(store.listCustomSkillInstallTargets()).toEqual([valid]);
    });

    it("每次现读不缓存：外部改写文件后立即反映", () => {
      const added = store.addCustomSkillInstallTarget({ name: "first", dir: path.join(fakeHome, "nc", "skills") });
      if (!added.ok) throw new Error("setup failed");
      const edited = [{ ...added.target, name: "edited" }];
      fs.writeFileSync(registryPath(), JSON.stringify({ version: 1, targets: edited }), "utf8");
      expect(store.listCustomSkillInstallTargets()).toEqual(edited);
    });
  });

  describe("installer × 自定义目标", () => {
    it("resolveTargetSkillsDir：内置命中、自定义命中、未知返回 null", () => {
      expect(installer.__test_only__.resolveTargetSkillsDir("agents")).toBe(
        path.join(fakeHome, ".agents", "skills"),
      );
      expect(installer.__test_only__.resolveTargetSkillsDir("claude")).toBe(
        path.join(fakeHome, ".claude", "skills"),
      );
      expect(installer.__test_only__.resolveTargetSkillsDir("custom-ffffffff")).toBeNull();
      expect(installer.__test_only__.resolveTargetSkillsDir("Bad_Id")).toBeNull();

      const added = store.addCustomSkillInstallTarget({ name: "t", dir: path.join(fakeHome, "t", "skills") });
      if (!added.ok) throw new Error("setup failed");
      expect(installer.__test_only__.resolveTargetSkillsDir(added.target.id)).toBe(
        added.target.skillsDir,
      );
    });

    it("installSkill 写入自定义目标目录，状态扫描包含自定义目标", async () => {
      const added = store.addCustomSkillInstallTarget({ name: "t", dir: path.join(fakeHome, "ci", "skills") });
      if (!added.ok) throw new Error("setup failed");

      const bundleJson = buildBundle("gpt-image", "1.0.0");
      const mock = await startBundleServer(bundleJson);
      try {
        const result = await installer.installSkill({
          bundleUrl: mock.url,
          sha512: mock.sha512,
          target: added.target.id,
          skillId: "gpt-image",
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.installedPath).toBe(path.join(added.target.skillsDir, "gpt-image"));

        const state = installer.getInstalledSkillState();
        const customEntry = state.skills.find((s) => s.target === added.target.id);
        expect(customEntry).toEqual({ skillId: "gpt-image", version: "1.0.0", target: added.target.id });
      } finally {
        await mock.close();
      }
    });

    it("installSkill 目标解析不到 → { ok: false, error: 'unknown-target' }", async () => {
      const result = await installer.installSkill({
        bundleUrl: "http://127.0.0.1:9/bundle.json",
        sha512: "x",
        target: "custom-ffffffff",
        skillId: "gpt-image",
      });
      expect(result).toEqual({ ok: false, error: "unknown-target" });
    });

    it("getInstalledSkillState：目标目录缺失跳过（不崩溃、无该目标条目），其余目标照常扫描", async () => {
      const added = store.addCustomSkillInstallTarget({ name: "gone", dir: path.join(fakeHome, "gone", "skills") });
      if (!added.ok) throw new Error("setup failed");
      fs.rmSync(added.target.skillsDir, { recursive: true, force: true });

      // 内置 agents 目标装一个 skill
      const bundleJson = buildBundle("gpt-image", "2.0.0");
      const mock = await startBundleServer(bundleJson);
      try {
        const result = await installer.installSkill({
          bundleUrl: mock.url,
          sha512: mock.sha512,
          target: "agents",
          skillId: "gpt-image",
        });
        expect(result.ok).toBe(true);

        const state = installer.getInstalledSkillState();
        expect(state.skills).toEqual([
          { skillId: "gpt-image", version: "2.0.0", target: "agents" },
        ]);
      } finally {
        await mock.close();
      }
    });
  });
});
