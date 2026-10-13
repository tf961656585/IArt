// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import type { DesktopEnv } from "../desktop-shell-utils.cjs";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const runtimeEntry = `${workspaceRoot}/apps/desktop-shell/dist/desktop-shell-runtime.cjs`;

type RuntimeModule = {
  injectSkillRuntimeDir: (env: DesktopEnv, isPackaged: boolean) => void;
};

const loadRuntimeModule = (): RuntimeModule =>
  requireDesktop(runtimeEntry) as RuntimeModule;

/**
 * 构造最小 DesktopEnv，只填充 injectSkillRuntimeDir 读写的字段。
 */
const makeEnv = (overrides: Partial<DesktopEnv> = {}): DesktopEnv =>
  ({
    IART_APP_VERSION: undefined,
    IART_DEV_EDITOR_URL: undefined,
    IART_EDITOR_STATIC_DIR: undefined,
    IART_HUB_DEV_URL: undefined,
    IART_HUB_STATIC_DIR: undefined,
    IART_BACKEND_PORT: undefined,
    IART_BACKEND_BASE_URL: undefined,
    IART_SQLITE_RUNTIME: undefined,
    IART_MODEL_ASSET_PACKAGES_DIR: undefined,
    IART_SKILL_RUNTIME_DIR: undefined,
    IART_E2E_REPORT_PATH: undefined,
    IART_E2E_AUTO_EXIT: undefined,
    IART_E2E_OPEN_EDITOR_PROJECT_PATH: undefined,
    IART_HUB_LOCAL_WRITE_TOKEN: undefined,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    NODE_ENV: undefined,
    ...overrides,
  }) as DesktopEnv;

describe("injectSkillRuntimeDir (spec docs/hub/skill-store.md)", () => {
  let runtime: RuntimeModule;

  beforeAll(() => {
    runtime = loadRuntimeModule();
  });

  describe("优先级 0a：开发者手动 env 不被覆盖", () => {
    it("env 已设置 IART_SKILL_RUNTIME_DIR 时，dev 模式也不覆盖", () => {
      const manualDir = "/manual/skill-runtime/override";
      const env = makeEnv({ IART_SKILL_RUNTIME_DIR: manualDir });

      runtime.injectSkillRuntimeDir(env, false);

      expect(env.IART_SKILL_RUNTIME_DIR).toBe(manualDir);
    });

    it("env 已设置 IART_SKILL_RUNTIME_DIR 时，打包模式也不覆盖", () => {
      const manualDir = "/manual/skill-runtime/override";
      const env = makeEnv({ IART_SKILL_RUNTIME_DIR: manualDir });

      runtime.injectSkillRuntimeDir(env, true);

      expect(env.IART_SKILL_RUNTIME_DIR).toBe(manualDir);
    });
  });

  describe("dev/prod 隔离（与 editor-storage-recent-projects 先例一致）", () => {
    it("dev 模式（isPackaged=false）注入 ~/.iart-studio-dev/skills-runtime 并创建目录", () => {
      // 用临时 HOME 隔离，避免污染真实用户目录
      const fakeHome = mkdtempSync(join(tmpdir(), "skill-runtime-home-"));
      const env = makeEnv({ HOME: fakeHome });
      const expectedDir = join(fakeHome, ".iart-studio-dev", "skills-runtime");

      try {
        runtime.injectSkillRuntimeDir(env, false);
        expect(env.IART_SKILL_RUNTIME_DIR).toBe(expectedDir);
        expect(existsSync(expectedDir)).toBe(true);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    it("打包模式（isPackaged=true）注入 ~/.iart-studio/skills-runtime 并创建目录", () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "skill-runtime-home-"));
      const env = makeEnv({ HOME: fakeHome });
      const expectedDir = join(fakeHome, ".iart-studio", "skills-runtime");

      try {
        runtime.injectSkillRuntimeDir(env, true);
        expect(env.IART_SKILL_RUNTIME_DIR).toBe(expectedDir);
        expect(existsSync(expectedDir)).toBe(true);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });
  });

  describe("目录创建行为", () => {
    it("目录已存在时不报错（幂等）", () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "skill-runtime-home-"));
      const env = makeEnv({ HOME: fakeHome });
      const expectedDir = join(fakeHome, ".iart-studio-dev", "skills-runtime");

      try {
        // 先创建目录，再注入
        // 注入函数内部会 mkdirSync recursive，已存在不报错
        runtime.injectSkillRuntimeDir(env, false);
        expect(env.IART_SKILL_RUNTIME_DIR).toBe(expectedDir);

        // 再次注入（幂等）
        const env2 = makeEnv({ HOME: fakeHome });
        runtime.injectSkillRuntimeDir(env2, false);
        expect(env2.IART_SKILL_RUNTIME_DIR).toBe(expectedDir);
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    it("HOME 缺失时仍不崩溃（mkdir 可能失败时跳过注入）", () => {
      const env = makeEnv({ HOME: "", USERPROFILE: "" });
      // HOME 和 USERPROFILE 均空时，路径为相对路径 .iart-studio-dev/skills-runtime
      // mkdirSync recursive 会尝试在 cwd 创建；不抛错即通过
      expect(() => runtime.injectSkillRuntimeDir(env, false)).not.toThrow();
    });
  });
});
