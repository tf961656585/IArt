import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
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
