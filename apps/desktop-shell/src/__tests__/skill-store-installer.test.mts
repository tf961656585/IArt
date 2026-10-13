// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const installerEntry = `${workspaceRoot}/apps/desktop-shell/dist/skill-store/skill-store-installer.cjs`;

type InstallerModule = {
  installSkill: (request: {
    bundleUrl: string;
    sha512: string;
    target: "agents" | "claude";
    skillId: string;
  }) => Promise<{ ok: true; installedPath: string } | { ok: false; error: string }>;
  getInstalledSkillState: () => { skills: Array<{ skillId: string; version: string; target: string }> };
  __test_only__: {
    isSafeRelativePath: (p: string) => boolean;
    resolveTargetSkillsDir: (target: "agents" | "claude") => string;
  };
};

const loadInstaller = (): InstallerModule =>
  requireDesktop(installerEntry) as InstallerModule;

// 启动 mock bundle server，返回 bundle JSON 与其 sha512。
const startBundleServer = (
  bundleJson: string,
  statusCode = 200,
): Promise<{
  server: http.Server;
  url: string;
  sha512: string;
  close: () => Promise<void>;
}> => {
  return new Promise((resolve) => {
    const sha512 = crypto.createHash("sha512").update(bundleJson, "utf8").digest("hex");
    const server = http.createServer((req, res) => {
      res.writeHead(statusCode, { "content-type": "application/json" });
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

const buildBundle = (
  id: string,
  version: string,
  files: Array<{ path: string; content: string; executable: boolean }>,
): string => JSON.stringify({ id, version, files });

describe("skill-store-installer (spec docs/hub/skill-store.md)", () => {
  let installer: InstallerModule;
  let fakeHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    installer = loadInstaller();
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "skill-installer-home-"));
    previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  describe("isSafeRelativePath", () => {
    it("拒绝绝对路径与 .. 穿越", () => {
      expect(installer.__test_only__.isSafeRelativePath("../evil.sh")).toBe(false);
      expect(installer.__test_only__.isSafeRelativePath("/etc/passwd")).toBe(false);
      expect(installer.__test_only__.isSafeRelativePath("a/../../b")).toBe(false);
    });

    it("接受合法相对路径", () => {
      expect(installer.__test_only__.isSafeRelativePath("SKILL.md")).toBe(true);
      expect(installer.__test_only__.isSafeRelativePath("scripts/run.sh")).toBe(true);
    });
  });

  describe("resolveTargetSkillsDir", () => {
    it("agents 目标解析到 ~/.agents/skills", () => {
      const dir = installer.__test_only__.resolveTargetSkillsDir("agents");
      expect(dir).toBe(path.join(fakeHome, ".agents", "skills"));
    });

    it("claude 目标解析到 ~/.claude/skills", () => {
      const dir = installer.__test_only__.resolveTargetSkillsDir("claude");
      expect(dir).toBe(path.join(fakeHome, ".claude", "skills"));
    });
  });

  describe("installSkill: 正常安装", () => {
    it("下载 + sha512 校验 + 写入目标目录 + 脚本可执行位", async () => {
      const bundleJson = buildBundle("gpt-image", "1.0.0", [
        { path: "SKILL.md", content: "# test", executable: false },
        { path: "skill.json", content: JSON.stringify({ id: "gpt-image", version: "1.0.0", name: "Test", description: "d" }), executable: false },
        { path: "scripts/run.sh", content: "#!/bin/bash", executable: true },
      ]);
      const mock = await startBundleServer(bundleJson);

      try {
        const result = await installer.installSkill({
          bundleUrl: mock.url,
          sha512: mock.sha512,
          target: "agents",
          skillId: "gpt-image",
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const installDir = path.join(fakeHome, ".agents", "skills", "gpt-image");
        expect(result.installedPath).toBe(installDir);
        expect(fs.existsSync(path.join(installDir, "SKILL.md"))).toBe(true);
        expect(fs.existsSync(path.join(installDir, "scripts", "run.sh"))).toBe(true);

        // 可执行文件权限 0o755
        const scriptStat = fs.statSync(path.join(installDir, "scripts", "run.sh"));
        expect(scriptStat.mode & 0o777).toBe(0o755);

        // 非可执行文件不设执行位
        const mdStat = fs.statSync(path.join(installDir, "SKILL.md"));
        expect(mdStat.mode & 0o111).toBe(0);
      } finally {
        await mock.close();
      }
    });

    it("覆盖安装先删除旧目录再写", async () => {
      const installDir = path.join(fakeHome, ".agents", "skills", "gpt-image");
      fs.mkdirSync(path.join(installDir, "old-subdir"), { recursive: true });
      fs.writeFileSync(path.join(installDir, "old-file.txt"), "old content");

      const bundleJson = buildBundle("gpt-image", "1.0.0", [
        { path: "SKILL.md", content: "# new", executable: false },
      ]);
      const mock = await startBundleServer(bundleJson);

      try {
        await installer.installSkill({
          bundleUrl: mock.url,
          sha512: mock.sha512,
          target: "agents",
          skillId: "gpt-image",
        });

        // 旧文件被清除
        expect(fs.existsSync(path.join(installDir, "old-file.txt"))).toBe(false);
        expect(fs.existsSync(path.join(installDir, "old-subdir"))).toBe(false);
        // 新文件存在
        expect(fs.existsSync(path.join(installDir, "SKILL.md"))).toBe(true);
      } finally {
        await mock.close();
      }
    });
  });

  describe("installSkill: 安全拒绝", () => {
    it("sha512 不匹配拒绝", async () => {
      const bundleJson = buildBundle("gpt-image", "1.0.0", [
        { path: "SKILL.md", content: "x", executable: false },
      ]);
      const mock = await startBundleServer(bundleJson);

      try {
        const result = await installer.installSkill({
          bundleUrl: mock.url,
          sha512: "0".repeat(128), // 错误的 sha512
          target: "agents",
          skillId: "gpt-image",
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toMatch(/sha512 mismatch/);
        // 安装目录不应被创建
        expect(fs.existsSync(path.join(fakeHome, ".agents", "skills", "gpt-image"))).toBe(false);
      } finally {
        await mock.close();
      }
    });

    it("bundle 含 .. 穿越路径拒绝且清理已写入文件", async () => {
      const bundleJson = buildBundle("gpt-image", "1.0.0", [
        { path: "SKILL.md", content: "x", executable: false },
        { path: "../evil.sh", content: "evil", executable: true },
      ]);
      const mock = await startBundleServer(bundleJson);

      try {
        const result = await installer.installSkill({
          bundleUrl: mock.url,
          sha512: mock.sha512,
          target: "agents",
          skillId: "gpt-image",
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toMatch(/evil\.sh/);
        // 安装目录应被清理（回滚）
        expect(fs.existsSync(path.join(fakeHome, ".agents", "skills", "gpt-image"))).toBe(false);
        // 穿越文件不应被写入
        expect(fs.existsSync(path.join(fakeHome, ".agents", "skills", "evil.sh"))).toBe(false);
      } finally {
        await mock.close();
      }
    });

    it("bundle id 与请求 skillId 不一致拒绝", async () => {
      const bundleJson = buildBundle("other-skill", "1.0.0", [
        { path: "SKILL.md", content: "x", executable: false },
      ]);
      const mock = await startBundleServer(bundleJson);

      try {
        const result = await installer.installSkill({
          bundleUrl: mock.url,
          sha512: mock.sha512,
          target: "agents",
          skillId: "gpt-image", // 请求 gpt-image 但 bundle 是 other-skill
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toMatch(/id.*不一致/);
      } finally {
        await mock.close();
      }
    });

    it("下载 HTTP 错误拒绝", async () => {
      const bundleJson = buildBundle("gpt-image", "1.0.0", [
        { path: "SKILL.md", content: "x", executable: false },
      ]);
      const mock = await startBundleServer(bundleJson, 500);

      try {
        const result = await installer.installSkill({
          bundleUrl: mock.url,
          sha512: mock.sha512,
          target: "agents",
          skillId: "gpt-image",
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toMatch(/HTTP 500/);
      } finally {
        await mock.close();
      }
    });
  });

  describe("getInstalledSkillState", () => {
    it("返回两目标目录中已安装 skill 的版本", async () => {
      // agents 目标安装 gpt-image@1.0.0
      const bundleJson1 = buildBundle("gpt-image", "1.0.0", [
        { path: "skill.json", content: JSON.stringify({ id: "gpt-image", version: "1.0.0", name: "G", description: "d" }), executable: false },
      ]);
      const mock1 = await startBundleServer(bundleJson1);

      // claude 目标安装 gpt-image@0.9.0
      const bundleJson2 = buildBundle("gpt-image", "0.9.0", [
        { path: "skill.json", content: JSON.stringify({ id: "gpt-image", version: "0.9.0", name: "G", description: "d" }), executable: false },
      ]);
      const mock2 = await startBundleServer(bundleJson2);

      try {
        await installer.installSkill({
          bundleUrl: mock1.url,
          sha512: mock1.sha512,
          target: "agents",
          skillId: "gpt-image",
        });
        await installer.installSkill({
          bundleUrl: mock2.url,
          sha512: mock2.sha512,
          target: "claude",
          skillId: "gpt-image",
        });

        const state = installer.getInstalledSkillState();
        expect(state.skills.length).toBe(2);
        const agentsEntry = state.skills.find((s) => s.target === "agents");
        const claudeEntry = state.skills.find((s) => s.target === "claude");
        expect(agentsEntry).toBeDefined();
        expect(agentsEntry?.version).toBe("1.0.0");
        expect(claudeEntry).toBeDefined();
        expect(claudeEntry?.version).toBe("0.9.0");
      } finally {
        await mock1.close();
        await mock2.close();
      }
    });

    it("目录不存在时返回空数组", () => {
      const state = installer.getInstalledSkillState();
      expect(state.skills).toEqual([]);
    });
  });
});
