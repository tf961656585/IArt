import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { UploadFileItem } from "../FileUpload";
import { FilePreviewDialog, useFilePreview } from "../FileUpload";

const IMAGE_ITEM: UploadFileItem = {
  id: "image-1",
  file: undefined,
  src: "https://example.com/image.png",
  dimensions: undefined,
};

const VIDEO_ITEM: UploadFileItem = {
  id: "video-1",
  file: undefined,
  src: "https://example.com/demo.mp4",
  dimensions: undefined,
};

function PreviewHarness() {
  const {
    previewItem,
    previewTitle,
    previewSrc,
    isVideoPreview,
    openPreview,
    closePreview,
  } = useFilePreview();

  return (
    <div>
      <button type="button" onClick={() => openPreview(IMAGE_ITEM)}>
        打开预览
      </button>
      <FilePreviewDialog
        open={Boolean(previewItem)}
        onOpenChange={(open) => {
          if (!open) {
            closePreview();
          }
        }}
        title={previewTitle}
        src={previewSrc}
        isVideo={isVideoPreview}
        emptyText="暂无可预览内容"
        closeText="关闭预览"
      />
    </div>
  );
}

function VideoHarness() {
  const {
    previewItem,
    previewTitle,
    previewSrc,
    isVideoPreview,
    openPreview,
    closePreview,
  } = useFilePreview();

  React.useEffect(() => {
    openPreview(VIDEO_ITEM);
  }, [openPreview]);

  return (
    <FilePreviewDialog
      open={Boolean(previewItem)}
      onOpenChange={(open) => {
        if (!open) {
          closePreview();
        }
      }}
      title={previewTitle}
      src={previewSrc}
      isVideo={isVideoPreview}
      emptyText="暂无可预览内容"
      closeText="关闭预览"
    />
  );
}

describe("FilePreviewDialog & useFilePreview", () => {
  it("打开后展示图片并支持 ESC 关闭", async () => {
    render(<PreviewHarness />);

    fireEvent.click(screen.getByRole("button", { name: "打开预览" }));

    await waitFor(() => {
      expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeInTheDocument();
    });

    const fullImage = screen.getByAltText("image-1") as HTMLImageElement;
    expect(fullImage).toHaveAttribute("src", IMAGE_ITEM.src);

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(document.querySelector('[data-slot="dialog-overlay"]')).not.toBeInTheDocument();
    });
  });

  it("识别视频类型并渲染 video 元素", async () => {
    render(<VideoHarness />);

    await waitFor(() => {
      expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeInTheDocument();
    });

    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video).toBeInTheDocument();
    expect(video.getAttribute("src")).toBe(VIDEO_ITEM.src);
  });
});
