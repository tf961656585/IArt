import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeInputsHash, isUpToDate, writeUpToDateState } from "./up-to-date-runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");
const editorAppDir = path.join(rootDir, "apps", "editor");
const editorTargetDir = path.join(rootDir, "apps", "editor", "dist-static");
const shouldBuildWorkspacePrereqs = process.env.IART_SKIP_WORKSPACE_PREREQS !== "1";

// Editor 静态产物 up-to-date 输入：vite 直接把 @iart/* 别名到 packages/*/src，
// 未被别名覆盖的包经 node_modules 消费 dist，因此 src 与 dist 都必须参与哈希；
// public/ 会被 vite 整体拷入 dist-static，也在输入集内。
const WORKSPACE_PACKAGES = ["contracts", "ui", "model-asset-runtime", "domain", "backend-sdk", "utils", "chat-adapter"];
const editorInputRoots = [
  "./tooling/build/build-editor-static.mjs",
  "./tooling/build/up-to-date-runner.mjs",
  "apps/editor/src",
  "apps/editor/index.html",
  "apps/editor/vite.desktop.config.ts",
  "apps/editor/postcss.config.mjs",
  "apps/editor/tsconfig.json",
  "apps/editor/package.json",
  "apps/editor/public",
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
    cwd: editorAppDir,
    env,
    shell: process.platform === "win32",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
};

const handleTerminate = (signal) => {
  console.warn(`[build-editor-static] 收到 ${signal}，准备清理临时目录。`);
  process.exit(1);
};

process.on("SIGINT", () => handleTerminate("SIGINT"));
process.on("SIGTERM", () => handleTerminate("SIGTERM"));

try {
  const inputsHash = computeInputsHash({ explicitRoots: editorInputRoots });
  // 发布链路或调用方注入 IART_FORCE_FRESH_BUILD=1 时跳过复用判定，强制清理重建
  if (process.env.IART_FORCE_FRESH_BUILD !== '1' && isUpToDate("editor-static", inputsHash)) {
    console.log("[build-editor-static] 输入未变化，复用现有 dist-static（本轮最新产物）");
    process.exit(0);
  }

  fs.rmSync(editorTargetDir, { recursive: true, force: true });
  if (shouldBuildWorkspacePrereqs) {
    run("pnpm", ["--filter", "@iart/contracts", "build"], process.env);
    run("pnpm", ["--filter", "@iart/ui", "build"], process.env);
    run("pnpm", ["--filter", "@iart/model-asset-runtime", "build"], process.env);
    run("pnpm", ["--filter", "@iart/domain", "build"], process.env);
    run("pnpm", ["--filter", "@iart/backend-sdk", "build"], process.env);
  }
  run("pnpm", ["exec", "vite", "build", "-c", "vite.desktop.config.ts"], process.env);

  if (!fs.existsSync(editorTargetDir)) {
    throw new Error("未生成 dist-static 目录，桌面 renderer 构建失败。");
  }
  writeUpToDateState("editor-static", inputsHash);
  console.log(`[build-editor-static] 已输出到 ${editorTargetDir}`);
} catch (error) {
  console.error("[build-editor-static] 失败：", error);
  process.exitCode = 1;
}
