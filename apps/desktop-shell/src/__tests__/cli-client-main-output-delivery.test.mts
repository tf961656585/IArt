// @vitest-environment node
//
// runCliClientMain 输出投递失败契约测试（静默失败根治，2026-10-14 批次）。
// @spec: CLI-025
//
// 旧行为：输出流写入失败只 process.emitWarning（GUI 子系统下不可见）且退出码不变——
// 「exit 0 + 双零字节」的假成功，消费方把静默当空结果。新契约（spec §4.1 / CLI-025）：
// 任一最终输出通道写入失败 → 尽力经另一通道（stderr）写一条可见错误 + 退出码置 2
// （守住 0/1/2 契约）；两通道都失败时无处可写，退出码 2 是最后防线。
//
// 失败信号的保真替身：传输层失败（EPIPE 等）在真实流上就是「write 回调携带 error」，
// 以回调失败替身驱动是该失败模式的直接形态（flush 语义另有真实流测试
// cli-client-main-flush.test.mts 覆盖，本文件不重复）。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const cliClientMainEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-client-main.cjs`;

type CliOutputTargetLike = { write(text: string, callback: (error?: Error | null) => void): unknown };
type CliClientMainModule = {
  runCliClientMain: (
    argv: readonly string[],
    streams?: { stdout: CliOutputTargetLike; stderr: CliOutputTargetLike },
  ) => Promise<number>;
};

const ensureDesktopShellBuild = () => {
  if (!existsSync(cliClientMainEntry)) {
    execFileSync("pnpm", ["--filter", "@iart/desktop-shell", "build"], {
      cwd: workspaceRoot,
      stdio: "pipe",
    });
  }
};

const loadModule = (): CliClientMainModule => {
  ensureDesktopShellBuild();
  return requireDesktop(cliClientMainEntry) as CliClientMainModule;
};

/** write 回调立即携带 error 的失败流替身（EPIPE 形态）。 */
const failingTarget = (): CliOutputTargetLike => ({
  write: (_text: string, callback: (error?: Error | null) => void) => {
    callback(new Error("EPIPE: broken pipe"));
    return false;
  },
});

/** write 回调成功并收集内容的收集流替身。 */
const collectingTarget = (): { target: CliOutputTargetLike; lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    target: {
      write: (text: string, callback: (error?: Error | null) => void) => {
        lines.push(text);
        callback(null);
        return true;
      },
    },
  };
};

describe("runCliClientMain 输出投递失败契约（CLI-025）", () => {
  it("stdout 写失败：尽力经 stderr 写可见错误 + 退出码 2（不再 exit 0 双零字节假成功）", async () => {
    const emitWarningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const err = collectingTarget();

    const exitCode = await loadModule().runCliClientMain(["--help"], { stdout: failingTarget(), stderr: err.target });

    expect(exitCode).toBe(2);
    // 可见错误落在另一通道（stderr）：诊断行 + 「不得当作空结果消费」警示
    const errText = err.lines.join("");
    expect(errText).toContain("输出流写入失败");
    expect(errText).toContain("不得当作空结果消费");
    expect(emitWarningSpy).toHaveBeenCalled();
    emitWarningSpy.mockRestore();
  });

  it("stderr 写失败（命令级错误输出不可达）：退出码仍置 2，不因诊断通道同败而上抛", async () => {
    const emitWarningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const exitCode = await loadModule().runCliClientMain(["no-such-command"], {
      stdout: collectingTarget().target,
      stderr: failingTarget(),
    });

    expect(exitCode).toBe(2);
    expect(emitWarningSpy).toHaveBeenCalled();
    emitWarningSpy.mockRestore();
  });

  it("双通道都写失败：无处可写不上抛，退出码 2 是最后防线（不回 0/1 假成功）", async () => {
    const emitWarningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    const exitCode = await loadModule().runCliClientMain(["--help"], {
      stdout: failingTarget(),
      stderr: failingTarget(),
    });

    expect(exitCode).toBe(2);
    emitWarningSpy.mockRestore();
  });

  it("写入全部成功时退出码语义不变（--help → 0），不误伤正常路径", async () => {
    const out = collectingTarget();
    const err = collectingTarget();

    const exitCode = await loadModule().runCliClientMain(["--help"], { stdout: out.target, stderr: err.target });

    expect(exitCode).toBe(0);
    expect(out.lines.join("")).toContain("iart — 驱动 IARTStudio 的命令行入口");
    expect(err.lines.join("")).toBe("");
  });
});
