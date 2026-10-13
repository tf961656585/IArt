// @vitest-environment node
// @spec: CLI-013, CLI-014
//
// 设置页「命令行工具」状态快照构建测试（spec §8 的 Main 侧基础）：
// DTO 形状完整（在役/端口/发现文件有效性/入口注册状态/最近命令记录）、
// recentCommands 截最近 20 条、发现文件有效性三分支（有效/损坏/缺失）。
import { createRequire } from "node:module";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CliStatusDtoSchema } from "@iart/contracts";

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const snapshotEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-status-snapshot.cjs`;
const discoveryEntry = `${workspaceRoot}/apps/desktop-shell/dist/cli/cli-discovery.cjs`;

type SnapshotModule = {
  buildCliStatusDto: (input: {
    serviceRunning: boolean;
    port: number | null;
    discoveryFilePath: string;
    entryRegistered: boolean | null;
    commandLog: readonly unknown[];
  }) => unknown;
  isDiscoveryFileValid: (filePath: string) => boolean;
  CLI_RECENT_COMMANDS_MAX: number;
};

type DiscoveryModule = {
  writeDiscoveryFile: (filePath: string, content: unknown) => void;
};

const loadSnapshotModule = (): SnapshotModule => requireDesktop(snapshotEntry) as SnapshotModule;
const loadDiscoveryModule = (): DiscoveryModule => requireDesktop(discoveryEntry) as DiscoveryModule;

let tempRoot = "";

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "cli-status-snapshot-"));
});

const makeLogEntry = (index: number) => ({
  timestamp: `2026-10-07T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
  command: "project.list",
  paramsSummary: `i=${index}`,
  status: "success",
  durationMs: index,
});

describe("cli-status-snapshot 状态快照（CLI-013 Main 侧基础）", () => {
  it("DTO 形状完整：在役/端口/发现文件/入口注册/最近命令，整体过契约校验", () => {
    const discoveryFilePath = join(tempRoot, "valid-discovery.json");
    loadDiscoveryModule().writeDiscoveryFile(discoveryFilePath, {
      port: 47823,
      token: "token-x",
      pid: process.pid,
      version: "0.6.2",
      startedAt: "2026-10-07T00:00:00.000Z",
    });
    const dto = loadSnapshotModule().buildCliStatusDto({
      serviceRunning: true,
      port: 47823,
      discoveryFilePath,
      entryRegistered: true,
      commandLog: [makeLogEntry(1), makeLogEntry(2)],
    }) as Record<string, unknown>;
    // buildCliStatusDto 出站即过 CliStatusDtoSchema.parse；此处再断言一次形状完整性
    expect(CliStatusDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto).toMatchObject({
      serviceRunning: true,
      port: 47823,
      discoveryFileValid: true,
      entryRegistered: true,
    });
    expect(Array.isArray(dto.recentCommands)).toBe(true);
    expect((dto.recentCommands as unknown[]).length).toBe(2);
  });

  it("recentCommands 截最近 20 条（CLI_RECENT_COMMANDS_MAX），按日志时序保序", () => {
    const snapshot = loadSnapshotModule();
    const entries = Array.from({ length: 25 }, (_, index) => makeLogEntry(index));
    const dto = snapshot.buildCliStatusDto({
      serviceRunning: true,
      port: 1234,
      discoveryFilePath: join(tempRoot, "missing-discovery.json"),
      entryRegistered: null,
      commandLog: entries,
    }) as { recentCommands: Array<{ paramsSummary: string }> };
    expect(snapshot.CLI_RECENT_COMMANDS_MAX).toBe(20);
    expect(dto.recentCommands).toHaveLength(20);
    // 截取窗口是「最近 20 条」：丢弃最旧的 5 条，保留末尾（最新）段
    expect(dto.recentCommands[0]?.paramsSummary).toBe("i=5");
    expect(dto.recentCommands[dto.recentCommands.length - 1]?.paramsSummary).toBe("i=24");
  });

  it("发现文件有效性三分支：有效 / 损坏 / 缺失；服务未运行端口为 null", () => {
    const snapshot = loadSnapshotModule();
    const validPath = join(tempRoot, "df-valid.json");
    loadDiscoveryModule().writeDiscoveryFile(validPath, {
      port: 47823,
      token: "t",
      pid: 1,
      version: "0.6.2",
      startedAt: "2026-10-07T00:00:00.000Z",
    });
    const corruptedPath = join(tempRoot, "df-corrupted.json");
    writeFileSync(corruptedPath, "not-json", { encoding: "utf8" });
    const missingPath = join(tempRoot, "df-missing.json");
    expect(existsSync(missingPath)).toBe(false);

    expect(snapshot.isDiscoveryFileValid(validPath)).toBe(true);
    expect(snapshot.isDiscoveryFileValid(corruptedPath)).toBe(false);
    expect(snapshot.isDiscoveryFileValid(missingPath)).toBe(false);

    const dto = snapshot.buildCliStatusDto({
      serviceRunning: false,
      port: null,
      discoveryFilePath: corruptedPath,
      entryRegistered: null,
      commandLog: [],
    }) as Record<string, unknown>;
    expect(CliStatusDtoSchema.safeParse(dto).success).toBe(true);
    expect(dto).toMatchObject({ serviceRunning: false, port: null, discoveryFileValid: false, entryRegistered: null });
  });
});
