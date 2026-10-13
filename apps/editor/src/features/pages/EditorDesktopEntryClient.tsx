"use client";

import { CanvasPageClient } from "@/features/pages/CanvasPageClient";

/**
 * 编辑器窗口入口。
 *
 * 历史上这里按窗口参数分流过一个内部开发页（「响应处理调试」）。该页已被
 * `docs/model-assets/35-模型资产添加与维护SOP.md` 取代并整页删除，入口不再分流。
 */
const EditorDesktopEntryClient: React.FC = () => {
  return <CanvasPageClient />;
};

export default EditorDesktopEntryClient;
