// @vitest-environment node
//
// main.cts CLI 分支 stdio 接线顺序 pin（Windows 中文乱码批次，2026-10-14）。
// @spec: CLI-022, CLI-023
//
// Windows 下 prepareCliStdio（句柄三元组探测 → 按需 AttachConsole 兜底 → 决策 → 写入器接管）
// 必须发生在 CLI 客户端动态加载之前，保证命令输出的每个字节都走决策后的通道；catch 路径
// 与正常路径共用同一 flush 序列。这是顺序敏感接线，编译器与运行时测试都观测不到，只能
// 源码级断言（风格照抄 main-window-open-coordinator.test.mts 的源码断言用例）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const mainSourcePath = `${workspaceRoot}/apps/desktop-shell/src/main.cts`;

describe("main.cts CLI 分支 stdio 接线顺序", () => {
  const source = readFileSync(mainSourcePath, "utf8");

  it("prepareCliStdio 调用位于 CLI 客户端动态 import 之前", () => {
    const prepareIndex = source.indexOf("prepareCliStdio()");
    const dynamicImportIndex = source.indexOf('import("./cli/cli-client-main.cjs")');
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(dynamicImportIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeLessThan(dynamicImportIndex);
  });

  it("prepareCliStdio 调用有 win32 门控，且门控先于首次 process.stdout 接触", () => {
    const gateIndex = source.indexOf('process.platform === "win32"');
    const prepareIndex = source.indexOf("prepareCliStdio()");
    const firstStdoutContact = source.indexOf("process.stdout");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(prepareIndex);
    expect(firstStdoutContact).toBeGreaterThan(prepareIndex);
  });

  it("退出等待 CLI 执行完成（await 后才 app.exit），catch 路径经同一 flush 序列写完成再退出", () => {
    const awaitedRunIndex = source.indexOf("await cliClientMain.runCliClientMain");
    const firstAppExitAfterRun = source.indexOf("app.exit", awaitedRunIndex);
    const catchWriteIndex = source.indexOf("writeCliOutput(cliStdio.stderr");
    expect(awaitedRunIndex).toBeGreaterThan(-1);
    expect(firstAppExitAfterRun).toBeGreaterThan(awaitedRunIndex);
    expect(catchWriteIndex).toBeGreaterThan(-1);
  });
});
