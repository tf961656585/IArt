import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileUpload, type UploadFileItem } from "../FileUpload";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  }),
}));

const buildItems = (count: number): UploadFileItem[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    file: undefined,
    src: `https://example.com/${index}.png`,
    dimensions: undefined,
  }));

describe("FileUpload compactPreview", () => {
  it("默认模式不受 compactPreview 影响（保持非紧凑展示）", () => {
    render(
      <FileUpload
        value={buildItems(12)}
        onFilesChange={vi.fn()}
        maxFiles={19}
      />,
    );

    const container = screen.getByTestId("file-upload-preview-container");
    expect(container).toHaveAttribute("data-compact-active", "false");
    expect(container.className).not.toContain("overflow-x-hidden");
  });

  it("开启 compactPreview 后，10-19 张场景启用 420px 高度上限和横向隐藏", () => {
    render(
      <FileUpload
        value={buildItems(12)}
        onFilesChange={vi.fn()}
        maxFiles={19}
        compactPreview
      />,
    );

    const container = screen.getByTestId("file-upload-preview-container");
    expect(container).toHaveAttribute("data-compact-active", "true");
    expect(container.className).toContain("overflow-x-hidden");
    expect(container).toHaveStyle({ maxHeight: "420px" });
  });

  it("compactPreview 阈值以下保持原样（不强制紧凑）", () => {
    render(
      <FileUpload
        value={buildItems(9)}
        onFilesChange={vi.fn()}
        maxFiles={19}
        compactPreview={{ enabled: true, activateAtCount: 10 }}
      />,
    );

    const container = screen.getByTestId("file-upload-preview-container");
    expect(container).toHaveAttribute("data-compact-active", "false");
  });

  it("previewMode=hidden 时隐藏预览列表但不影响上传模式默认值", () => {
    render(
      <FileUpload
        value={buildItems(3)}
        onFilesChange={vi.fn()}
        maxFiles={19}
        previewMode="hidden"
        previewLayout="inspectorGrid"
      />,
    );

    expect(
      screen.queryByTestId("file-upload-preview-container"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "fileUpload.select" }),
    ).toBeInTheDocument();
  });
});

describe("FileUpload inspectorGrid", () => {
  it.each([
    [1, "1"],
    [2, "2"],
    [3, "3"],
    [4, "3"],
  ])("按 Inspector 窄面板规则为 %i 个文件设置网格列数", (count, columns) => {
    render(
      <FileUpload
        value={buildItems(count)}
        onFilesChange={vi.fn()}
        maxFiles={9}
        previewLayout="inspectorGrid"
      />,
    );

    const container = screen.getByTestId("file-upload-preview-container");
    expect(container).toHaveAttribute("data-preview-layout", "inspectorGrid");
    expect(container).toHaveAttribute("data-grid-columns", columns);
  });

  it("4 个及以上文件启用 Inspector 预览滚动容器，但不触发 compactPreview 旧语义", () => {
    render(
      <FileUpload
        value={buildItems(4)}
        onFilesChange={vi.fn()}
        maxFiles={9}
        previewLayout="inspectorGrid"
      />,
    );

    const container = screen.getByTestId("file-upload-preview-container");
    expect(container).toHaveAttribute("data-compact-active", "false");
    expect(container.className).toContain("max-h-60");
    expect(container.className).toContain("overflow-y-auto");
  });

  it("保留预览、删除与图片处理操作入口", () => {
    render(
      <FileUpload
        value={buildItems(1)}
        onFilesChange={vi.fn()}
        maxFiles={3}
        previewLayout="inspectorGrid"
      />,
    );

    expect(
      screen.getByRole("button", { name: "fileUpload.preview" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "fileUpload.remove" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "fileUpload.process" }),
    ).toBeInTheDocument();
  });

  it("Inspector 网格操作区默认可见并使用两列换行布局", () => {
    render(
      <FileUpload
        value={buildItems(4)}
        onFilesChange={vi.fn()}
        maxFiles={9}
        previewLayout="inspectorGrid"
      />,
    );

    const actionContainers = screen.getAllByTestId(
      "file-upload-preview-actions",
    );
    const actions = actionContainers[0];
    if (!actions) throw new Error("Inspector 操作区未渲染");
    expect(actions).toHaveClass("grid-cols-2");
    expect(actions.className).not.toContain("opacity-0");
    expect(actions.className).not.toContain("group-hover");
  });
});
