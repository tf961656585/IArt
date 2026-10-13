import type { BrowserWindow } from "electron";
import { shouldEnableDevToolsShortcuts } from "../utils/devtools-policy.cjs";

type DevToolsShortcutInput = {
  type: unknown | undefined;
  key: unknown | undefined;
  code: unknown | undefined;
  control: unknown | undefined;
  meta: unknown | undefined;
  shift: unknown | undefined;
};

const attachedWindows = new WeakSet<BrowserWindow>();

export const isDevToolsShortcutInput = (input: DevToolsShortcutInput) => {
  if (input.type !== "keyDown") return false;
  const key = typeof input.key === "string" ? input.key.toLowerCase() : "";
  const code = typeof input.code === "string" ? input.code.toLowerCase() : "";
  if (key === "f12" || code === "f12") return true;
  const isIKey = key === "i" || code === "keyi";
  return Boolean(isIKey && input.shift && (input.control || input.meta));
};

export const attachDevToolsShortcuts = (win: BrowserWindow) => {
  if (!shouldEnableDevToolsShortcuts()) return;
  if (attachedWindows.has(win)) return;
  attachedWindows.add(win);

  win.webContents.on("before-input-event", (event, input) => {
    if (!isDevToolsShortcutInput(input)) return;
    event.preventDefault();
    win.webContents.toggleDevTools();
  });
};
