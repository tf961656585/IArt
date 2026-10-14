// @vitest-environment node
//
// GUI bootstrap 的 shim 自愈接线 pin（spec §3 / CLI-031，2026-10-14 批次）。
// @spec: CLI-031
//
// 自愈能力本体（healEntryShims 分桶语义）由 cli-entry-registration.test.mts 验证；本文件
// pin 的是「应用启动时真的会被调用」这一顺序敏感接线：healCliEntryShims 在 whenReady 内
// fire-and-forget 调用（不 await、不阻断启动主链），结果与失败经 appendMainLog 落
// logs/main.log（主进程留痕落文件纪律——打包态 console 不可见）。编译器与运行时测试都
// 观测不到接线，只能源码级断言（风格照抄 cli-main-stdio-wiring.test.mts）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();
const bootstrapSourcePath = `${workspaceRoot}/apps/desktop-shell/src/desktop-shell-bootstrap.cts`;

describe("desktop-shell-bootstrap 的 shim 自愈接线（CLI-031）", () => {
  const source = readFileSync(bootstrapSourcePath, "utf8");
  const whenReadyIndex = source.indexOf("app.whenReady()");

  it("healEntryShims 在 bootstrap 中被调用，且调用位于 whenReady 之后（应用启动时自愈）", () => {
    const healCallIndex = source.indexOf("healCliEntryShims();");
    expect(healCallIndex).toBeGreaterThan(-1);
    expect(whenReadyIndex).toBeGreaterThan(-1);
    expect(healCallIndex).toBeGreaterThan(whenReadyIndex);
  });

  it("自愈调用为 fire-and-forget（healCliEntryShims 内部 void 前缀，不 await、不阻断启动主链）", () => {
    const healFnIndex = source.indexOf("const healCliEntryShims = ");
    expect(healFnIndex).toBeGreaterThan(-1);
    const healFnBody = source.slice(healFnIndex, healFnIndex + 400);
    expect(healFnBody).toContain("void cliEntryRegistration.healEntryShims()");
    expect(healFnBody).not.toContain("await");
  });

  it("自愈结果与失败均落 main.log（appendMainLog；主进程留痕必须落文件的仓库纪律）", () => {
    const healFnIndex = source.indexOf("const healCliEntryShims = ");
    const healFnBody = source.slice(healFnIndex, source.indexOf("};", healFnIndex));
    expect(healFnBody).toContain('appendMainLog("warn"');
    expect(healFnBody).toContain('appendMainLog("info"');
    expect(source.includes('import { appendMainLog } from "./main-log.cjs"')).toBe(true);
  });

  it("自愈使用注册模块的生产实例（与设置页一键注册同一内容事实源）", () => {
    expect(source).toContain("cliEntryRegistration.healEntryShims()");
    // 入口脚本路径解析：打包态走 extraResources（resources/cli/，resourcesPath 需为字符串——
    // 纯 Node 测试环境无该全局，回退 dev 解析），dev 态走 dist/cli 同级产物
    expect(source).toContain('typeof resourcesPath === "string"');
    expect(source).toContain('path.join(resourcesPath, "cli", "cli-node-entry.cjs")');
    expect(source).toContain('"cli", "cli-node-entry.cjs"');
  });
});
