import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // 线程池而非默认的 forks 池（2026-11-07 实测）：本仓的接缝测试会临时接管
    // `process.send`（backend 单向通知的出口），在 forks 池里这会污染 vitest 自己的
    // tinypool 传输通道，父进程按二进制协议反序列化普通对象后直接
    // `ERR_INVALID_ARG_TYPE` 崩溃，整份套件无法跑完（并留下孤儿 worker）。
    // 线程池没有进程级 IPC 通道，同一批测试可正常跑完。
    pool: "threads",
    // 测试运行时前置（docs/harness/gates.md「测试入口运行时」）：Node 25 在 worker 线程收尾
    // 阶段的 V8 内存回收里随机段错误（退出码 139，无失败用例）。globalSetup 用于覆盖
    // `npx vitest run`、`pnpm test:watch` 等绕过 package 脚本的入口，判据与 `pnpm test`
    // 的首个命令共用 tooling/scripts/assert-node-runtime.mjs 同一份实现。
    globalSetup: ["./tooling/scripts/assert-node-runtime.mjs"],
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    // React 19 的 act 仅在 react.development.js 中导出（production 变体剥离）。
    // vitest 默认 mode="test" 会让 Vite 把 NODE_ENV define 为 "test"，导致加载到
    // 剥离了 act 的变体，引发 "React.act is not a function"。强制 development 保证
    // react.development.js 被加载，与 vitest.setup.ts 的 IS_REACT_ACT_ENVIRONMENT 配合。
    env: {
      NODE_ENV: "development",
    },
    include: [
      "apps/editor/src/**/*.{test,spec}.{ts,tsx}",
      "apps/hub/src/**/*.{test,spec}.{ts,tsx}",
      "apps/desktop-shell/src/__tests__/**/*.{test,spec}.mts",
      "packages/chat-adapter/__tests__/**/*.{test,spec}.{ts,tsx}",
      "packages/contracts/__tests__/**/*.{test,spec}.{ts,tsx}",
      "packages/domain/tests/**/*.{test,spec}.{ts,tsx}",
      "packages/model-asset-runtime/__tests__/**/*.{test,spec}.{ts,tsx}",
      "packages/utils/__tests__/**/*.{test,spec}.{ts,tsx}",
      "packages/ui/__tests__/**/*.{test,spec}.{ts,tsx}",
      "testing/integration/**/*.{test,spec}.{ts,tsx}",
    ],
    css: true,
  },
  resolve: {
    alias: [
      {
        find: "@",
        replacement: path.resolve(__dirname, "./apps/editor/src"),
      },
    ],
  },
});
