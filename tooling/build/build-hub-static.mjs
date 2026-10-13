import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeInputsHash, isUpToDate, writeUpToDateState } from "./up-to-date-runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");
const hubAppDir = path.join(rootDir, "apps", "hub");
const hubTargetDir = path.join(rootDir, "apps", "hub", "dist-static");
const shouldBuildWorkspacePrereqs = process.env.IART_SKIP_WORKSPACE_PREREQS !== "1";

// Hub 静态产物 up-to-date 输入：vite 直接把 @iart/* 别名到 packages/*/src，
// 未被别名覆盖的包经 node_modules 消费 dist，因此 src 与 dist 都必须参与哈希。
const WORKSPACE_PACKAGES = ["contracts", "ui", "model-asset-runtime", "domain", "backend-sdk", "utils", "chat-adapter"];
const hubInputRoots = [
  "./tooling/build/build-hub-static.mjs",
  "./tooling/build/up-to-date-runner.mjs",
  "apps/hub/src",
  "apps/hub/vite.config.ts",
  "apps/hub/tsconfig.json",
  "apps/hub/tsconfig.node.json",
  "apps/hub/package.json",
  "packages/config",
  "pnpm-lock.yaml",
  ...WORKSPACE_PACKAGES.flatMap((name) => [
    `packages/${name}/src`,
    `packages/${name}/dist`,
    `packages/${name}/package.json`,
  ]),
];

const run = (command, args, env) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: hubAppDir,
    env,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
};

const handleTerminate = (signal) => {
  console.warn(`[build-hub-static] 收到 ${signal}，准备清理临时目录。`);
  process.exit(1);
};

process.on("SIGINT", () => handleTerminate("SIGINT"));
process.on("SIGTERM", () => handleTerminate("SIGTERM"));

try {
  const inputsHash = computeInputsHash({ explicitRoots: hubInputRoots });
  // 发布链路或调用方注入 IART_FORCE_FRESH_BUILD=1 时跳过复用判定，强制清理重建
  if (process.env.IART_FORCE_FRESH_BUILD !== '1' && isUpToDate("hub-static", inputsHash)) {
    console.log("[build-hub-static] 输入未变化，复用现有 dist-static（本轮最新产物）");
    process.exit(0);
  }

  fs.rmSync(hubTargetDir, { recursive: true, force: true });
  if (shouldBuildWorkspacePrereqs) {
    run("pnpm", ["--filter", "@iart/contracts", "build"], process.env);
    run("pnpm", ["--filter", "@iart/domain", "build"], process.env);
    run("pnpm", ["--filter", "@iart/ui", "build"], process.env);
  }
  run("pnpm", ["exec", "vite", "build", "-c", "vite.config.ts"], process.env);
  if (!fs.existsSync(path.join(hubTargetDir, "index.html"))) {
    throw new Error("未生成 dist-static/index.html，Hub 构建失败。");
  }
  writeUpToDateState("hub-static", inputsHash);
  console.log(`[build-hub-static] 已输出到 ${hubTargetDir}`);
} catch (error) {
  console.error("[build-hub-static] 失败：", error);
  process.exitCode = 1;
}
