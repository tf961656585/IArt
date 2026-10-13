// 自研更新协议（自研 checker/downloader）已迁移到 electron-updater。
// 本文件只剩装配职责：发布地址解析的导出面与 UpdaterController 的创建入口。
// 状态机、事件映射、节流、pending 与安装语义全部承载在 electron-updater 桥接模块中。
import type { BrowserWindow } from "electron";
export { resolveUpdatePublishUrl } from "./update/electron-updater-bridge.cjs";
export type { UpdaterController } from "./update/electron-updater-bridge.cjs";
import { createElectronUpdaterController } from "./update/electron-updater-bridge.cjs";
import type { UpdaterController } from "./update/electron-updater-bridge.cjs";

export const createUpdaterController = ({
  getMainWindow,
  setAllowQuit,
}: {
  getMainWindow: () => BrowserWindow | null;
  setAllowQuit: (value: boolean) => void;
}): UpdaterController =>
  createElectronUpdaterController({ getMainWindow, setAllowQuit });
