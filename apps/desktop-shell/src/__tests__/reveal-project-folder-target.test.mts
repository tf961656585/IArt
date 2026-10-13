// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { RevealProjectFolderResultSchema } from "@iart/contracts";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const revealTargetEntry = `${workspaceRoot}/apps/desktop-shell/dist/reveal/revealProjectFolderTarget.cjs`;

const ensureDesktopShellBuild = (): void => {
  if (existsSync(revealTargetEntry)) return;
  execFileSync("pnpm", ["--filter", "@iart/desktop-shell", "build"], {
    cwd: workspaceRoot,
    stdio: "pipe",
  });
};

type RevealProjectFolderTargetModule = {
  revealProjectFolderTarget: (params?: {
    targetPath: string | null | undefined;
    shell: {
      showItemInFolder: (filePath: string) => void;
    } | null | undefined;
  }) => Promise<{ ok: boolean; path?: string; reason?: string }>;
};

const loadRevealTargetModule = (): RevealProjectFolderTargetModule =>
  requireDesktop(revealTargetEntry) as RevealProjectFolderTargetModule;

/**
 * 定位项目目录或导出文件（spec docs/editor/本地文件快捷跳转.md）：
 * - 目录类（Hub 项目卡「打开所在文件夹」）定位并高亮目录本身（LFJ-010）；
 * - 文件类（Hub 导出项目完成后自动定位 .iarts.zip，判据五历史特例）定位并高亮文件本身。
 * 回归点：主进程旧实现 stat.isDirectory() 把文件路径一律拒成 path-missing，
 * 导出 .iarts.zip 后的自动定位从未成功过（Hub 侧 .catch(() => undefined) 静默吞掉）。
 */
describe("revealProjectFolderTarget", () => {
  beforeAll(() => {
    ensureDesktopShellBuild();
  });

  it("reveals an existing file and highlights the file itself (导出 .iarts.zip 文件路径)", async () => {
    // @spec: LFJ-010
    const mod = loadRevealTargetModule();
    const dir = mkdtempSync(`${tmpdir()}/iart-reveal-file-`);
    const filePath = path.join(dir, "project.iarts.zip");
    writeFileSync(filePath, "zip-data");

    const showItemInFolder = vi.fn();
    const result = await mod.revealProjectFolderTarget({
      targetPath: filePath,
      shell: { showItemInFolder },
    });

    expect(result).toEqual({ ok: true, path: filePath });
    expect(RevealProjectFolderResultSchema.safeParse(result).success).toBe(true);
    expect(showItemInFolder).toHaveBeenCalledTimes(1);
    expect(showItemInFolder).toHaveBeenCalledWith(filePath);
  });

  it("reveals an existing directory and highlights the directory itself (目录语义不变)", async () => {
    // @spec: LFJ-010
    const mod = loadRevealTargetModule();
    const dir = mkdtempSync(`${tmpdir()}/iart-reveal-dir-`);

    const showItemInFolder = vi.fn();
    const result = await mod.revealProjectFolderTarget({
      targetPath: dir,
      shell: { showItemInFolder },
    });

    expect(result).toEqual({ ok: true, path: dir });
    expect(RevealProjectFolderResultSchema.safeParse(result).success).toBe(true);
    expect(showItemInFolder).toHaveBeenCalledTimes(1);
    expect(showItemInFolder).toHaveBeenCalledWith(dir);
  });

  it("returns path-missing and skips shell when target does not exist", async () => {
    // @spec: LFJ-011
    const mod = loadRevealTargetModule();
    const missing = path.join(tmpdir(), `iart-reveal-missing-${Date.now()}`);

    const showItemInFolder = vi.fn();
    const result = await mod.revealProjectFolderTarget({
      targetPath: missing,
      shell: { showItemInFolder },
    });

    expect(result).toEqual({ ok: false, reason: "path-missing", path: missing });
    expect(RevealProjectFolderResultSchema.safeParse(result).success).toBe(true);
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it("returns not-absolute for a relative path", async () => {
    const mod = loadRevealTargetModule();
    const showItemInFolder = vi.fn();
    const result = await mod.revealProjectFolderTarget({
      targetPath: "relative/dir",
      shell: { showItemInFolder },
    });

    expect(result).toEqual({ ok: false, reason: "not-absolute", path: "relative/dir" });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it("returns not-absolute for an empty or missing path", async () => {
    const mod = loadRevealTargetModule();
    const showItemInFolder = vi.fn();

    const empty = await mod.revealProjectFolderTarget({
      targetPath: "   ",
      shell: { showItemInFolder },
    });
    expect(empty).toEqual({ ok: false, reason: "not-absolute", path: "" });

    const missing = await mod.revealProjectFolderTarget({
      targetPath: undefined,
      shell: { showItemInFolder },
    });
    expect(missing).toEqual({ ok: false, reason: "not-absolute", path: "" });

    expect(showItemInFolder).not.toHaveBeenCalled();
  });
});
