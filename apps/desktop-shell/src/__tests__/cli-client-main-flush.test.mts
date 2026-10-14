// @vitest-environment node
//
// runCliClientMain flush 序列测试（Windows 中文乱码批次，2026-10-14）。
//
// app.exit(n) 不等待 libuv 刷新：退出信号发出时仍滞留在流缓冲里的输出会被直接丢弃。
// 故用真实 fs.createWriteStream 作为注入流断言「退出信号发出（promise resolve）时输出
// 内容已完整落盘」，随后立刻 destroy 流（等价 app.exit 的即时退出语义）。禁止用
// mock/stub 顶替真实流。
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const cliClientMainEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-client-main.cjs`;

type CliClientMainStreams = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
type CliClientMainModule = {
  runCliClientMain: (argv: readonly string[], streams: CliClientMainStreams) => Promise<number>;
};

const ensureDesktopShellBuild = () => {
  if (existsSync(cliClientMainEntry)) return;
  execFileSync("pnpm", ["--filter", "@iart/desktop-shell", "build"], {
    cwd: workspaceRoot,
    stdio: "pipe",
  });
};

const loadModule = (): CliClientMainModule => requireDesktop(cliClientMainEntry) as CliClientMainModule;

let tempRoot = "";

beforeAll(() => {
  ensureDesktopShellBuild();
  tempRoot = mkdtempSync(join(tmpdir(), "cli-client-main-flush-"));
});

/** 以即时 destroy 模拟 app.exit：resolve 后不留任何刷新机会，直接判「落盘与否」。 */
const readAfterExitSignal = (filePath: string, stream: NodeJS.WritableStream): string => {
  stream.destroy();
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
};

describe("runCliClientMain flush 序列（退出信号发出时输出必须已完整落盘）", () => {
  it("--help：stdout 用法提示在退出信号发出前已完整落盘", async () => {
    const outPath = join(tempRoot, "help-out.log");
    const errPath = join(tempRoot, "help-err.log");
    const stdout = createWriteStream(outPath);
    const stderr = createWriteStream(errPath);

    const exitCode = await loadModule().runCliClientMain(["--help"], { stdout, stderr });

    expect(exitCode).toBe(0);
    expect(readAfterExitSignal(outPath, stdout)).toContain("iart — 驱动 IARTStudio 的命令行入口");
    expect(readAfterExitSignal(errPath, stderr)).toBe("");
  });

  it("参数错误：stderr 错误与用法提示在退出信号发出前已完整落盘", async () => {
    const outPath = join(tempRoot, "bad-out.log");
    const errPath = join(tempRoot, "bad-err.log");
    const stdout = createWriteStream(outPath);
    const stderr = createWriteStream(errPath);

    const exitCode = await loadModule().runCliClientMain(["no-such-command"], { stdout, stderr });

    expect(exitCode).toBe(2);
    expect(readAfterExitSignal(errPath, stderr)).toContain("退出码：0 成功");
    expect(readAfterExitSignal(outPath, stdout)).toBe("");
  });
});
