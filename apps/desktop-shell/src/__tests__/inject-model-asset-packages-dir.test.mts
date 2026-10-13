// @vitest-environment node
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import type { DesktopEnv } from "../desktop-shell-utils.cjs";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const runtimeEntry = `${workspaceRoot}/apps/desktop-shell/dist/desktop-shell-runtime.cjs`;

type RuntimeModule = {
  injectModelAssetPackagesDir: (env: DesktopEnv, isPackaged: boolean) => void;
  cleanupLegacyModelAssetSyncedDirectory: (userDataDir: string) => void;
};

const loadRuntimeModule = (): RuntimeModule =>
  requireDesktop(runtimeEntry) as RuntimeModule;

/**
 * 构造最小 DesktopEnv，只填充 injectModelAssetPackagesDir 读写的字段。
 * 其余字段在该决策函数中不被访问，用 undefined 占位。
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
    IART_E2E_REPORT_PATH: undefined,
    IART_E2E_AUTO_EXIT: undefined,
    IART_E2E_OPEN_EDITOR_PROJECT_PATH: undefined,
    IART_HUB_LOCAL_WRITE_TOKEN: undefined,
    ...overrides,
  }) as DesktopEnv;

describe("injectModelAssetPackagesDir", () => {
  let runtime: RuntimeModule;
  const repoPackagesDir = `${workspaceRoot}/.model-assets/packages`;

  beforeAll(() => {
    runtime = loadRuntimeModule();
  });

  describe("env override：开发者手动 env 不被覆盖", () => {
    it("env 已设置 IART_MODEL_ASSET_PACKAGES_DIR 时，dev 模式也不覆盖", () => {
      const manualDir = "/manual/override/path";
      const env = makeEnv({ IART_MODEL_ASSET_PACKAGES_DIR: manualDir });

      runtime.injectModelAssetPackagesDir(env, false);

      expect(env.IART_MODEL_ASSET_PACKAGES_DIR).toBe(manualDir);
    });

    it("env 已设置 IART_MODEL_ASSET_PACKAGES_DIR 时，打包模式也不覆盖", () => {
      const manualDir = "/manual/override/path";
      const env = makeEnv({ IART_MODEL_ASSET_PACKAGES_DIR: manualDir });

      runtime.injectModelAssetPackagesDir(env, true);

      expect(env.IART_MODEL_ASSET_PACKAGES_DIR).toBe(manualDir);
    });
  });

  describe("dev 模式自动指向仓库 packages 目录", () => {
    // 仓库 .model-assets/packages 在正常开发环境下存在；
    // CI 若剥离资产目录则跳过本用例。
    const itIfRepo = existsSync(repoPackagesDir) ? it : it.skip;

    itIfRepo("dev 模式（isPackaged=false）注入仓库 .model-assets/packages", () => {
      const env = makeEnv();

      runtime.injectModelAssetPackagesDir(env, false);

      expect(env.IART_MODEL_ASSET_PACKAGES_DIR).toBe(repoPackagesDir);
    });

    // 打包模式（isPackaged=true）不注入任何目录：
    // 模型能力包只随软件安装包内置分发，backend 走默认探测（resolveModelPackagesRoot）
    // 命中 Resources/model-assets，env 保持 undefined 即可。
  });
});

describe("cleanupLegacyModelAssetSyncedDirectory", () => {
  let runtime: RuntimeModule;

  beforeAll(() => {
    runtime = loadRuntimeModule();
  });

  /** 构造一次性 userData 仿真目录（临时目录内），用后由清理函数或用例自行删除。 */
  const makeFakeUserData = (): string => mkdtempSync(path.join(tmpdir(), "iart-userdata-"));

  it("存在历史同步目录 model-assets-synced 时递归删除", () => {
    const userDataDir = makeFakeUserData();
    const syncDir = path.join(userDataDir, "model-assets-synced");
    mkdirSync(path.join(syncDir, "some-package"), { recursive: true });
    writeFileSync(path.join(syncDir, "some-package", "model.json"), "{}", "utf8");

    runtime.cleanupLegacyModelAssetSyncedDirectory(userDataDir);

    expect(existsSync(syncDir)).toBe(false);
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("同步目录的历史临时目录残留一并清理", () => {
    const userDataDir = makeFakeUserData();
    const tempDir = path.join(userDataDir, "model-assets-synced.tmp-42");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(path.join(tempDir, "partial.bin"), "x", "utf8");

    runtime.cleanupLegacyModelAssetSyncedDirectory(userDataDir);

    expect(existsSync(tempDir)).toBe(false);
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("不存在同步目录时为空操作，不影响 userData 内其他内容", () => {
    const userDataDir = makeFakeUserData();
    const unrelated = path.join(userDataDir, "unrelated-dir");
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(path.join(userDataDir, "keep.txt"), "keep", "utf8");

    runtime.cleanupLegacyModelAssetSyncedDirectory(userDataDir);

    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(path.join(userDataDir, "keep.txt"))).toBe(true);
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("只清理同名的同步目录与 tmp 前缀目录，不误删名字相近的其他目录", () => {
    const userDataDir = makeFakeUserData();
    const lookalike = path.join(userDataDir, "model-assets-synced-old");
    mkdirSync(lookalike, { recursive: true });

    runtime.cleanupLegacyModelAssetSyncedDirectory(userDataDir);

    expect(existsSync(lookalike)).toBe(true);
    rmSync(userDataDir, { recursive: true, force: true });
  });
});
