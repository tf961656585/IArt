import { app, type BrowserWindow } from "electron";
import * as fs from "node:fs";
import {
  DesktopE2EEventPayloadSchema,
  OpenEditorWindowRequestSchema,
  type DesktopE2EEventPayload,
  type OpenEditorWindowRequest,
} from "@iart/contracts";
import { getDesktopEnv, normalizeDesktopString } from "./desktop-shell-utils.cjs";

export const getDesktopE2EReportPath = () =>
  normalizeDesktopString(getDesktopEnv().IART_E2E_REPORT_PATH);

export const isDesktopE2EEnabled = () => Boolean(getDesktopE2EReportPath());

export const reportDesktopE2EEvent = (payload: DesktopE2EEventPayload) => {
  const reportPath = getDesktopE2EReportPath();
  if (!reportPath) return false;
  const event = DesktopE2EEventPayloadSchema.parse(payload);
  fs.appendFileSync(
    reportPath,
    `${JSON.stringify({ ...event, at: Date.now() })}\n`,
    "utf8",
  );
  return true;
};

export const resolveDesktopE2EOpenEditorRequest =
  (): OpenEditorWindowRequest | null => {
    if (!isDesktopE2EEnabled()) return null;
    const projectPath = normalizeDesktopString(
      getDesktopEnv().IART_E2E_OPEN_EDITOR_PROJECT_PATH,
    );
    if (!projectPath) return null;
    return OpenEditorWindowRequestSchema.parse({
      projectPath,
      sessionToken: `desktop:e2e:${Date.now()}`,
    });
  };

export const maybeAutoExitAfterDesktopE2E = () => {
  if (
    isDesktopE2EEnabled() &&
    normalizeDesktopString(getDesktopEnv().IART_E2E_AUTO_EXIT) === "1"
  ) {
    app.quit();
  }
};

export const bindDesktopE2EWindowLoaded = (
  win: BrowserWindow,
  eventType: string,
) => {
  if (!isDesktopE2EEnabled()) return;
  win.webContents.once("did-finish-load", () => {
    reportDesktopE2EEvent({
      type: eventType,
      detail: { url: win.webContents.getURL() },
    });
  });
};
