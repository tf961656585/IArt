import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorProjectStateSync } from "../useEditorProjectStateSync";

describe("useEditorProjectStateSync (IPC 模式)", () => {
  // 稳定引用：hook 的 effect 依赖 onStatusChange 包装出的 callback，
  // 每次渲染新建的函数字面量会导致 effect 反复重跑（setStatus 新对象 → 重渲染 → 无限循环）。
  const stableOnStatusChange = () => undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enabled=true 时直接返回 connected 状态", async () => {
    const { result } = renderHook(() =>
      useEditorProjectStateSync("/tmp/demo.iartproj", {
        enabled: true,
        connectTimeoutMs: undefined,
        onStatusChange: stableOnStatusChange,
      }),
    );

    await waitFor(() =>
      expect(result.current).toMatchObject({
        level: "connected",
        code: "connected",
      }),
    );
  });

  it("enabled=false 时返回 idle 状态", async () => {
    const { result } = renderHook(() =>
      useEditorProjectStateSync("/tmp/demo.iartproj", {
        enabled: false,
        connectTimeoutMs: undefined,
        onStatusChange: stableOnStatusChange,
      }),
    );

    await waitFor(() =>
      expect(result.current).toMatchObject({
        level: "idle",
        code: null,
      }),
    );
  });
});
