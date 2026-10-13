import fs from 'node:fs';

export const requiredDesktopE2EEvents = Object.freeze([
  'app-ready',
  'backend-listening',
  'hub-window-loaded',
  'hub-open-editor-succeeded',
  'editor-window-loaded',
  'renderer-bootstrap-ready',
]);

export const readDesktopE2EReportEntries = (reportPath) => {
  if (!fs.existsSync(reportPath)) {
    return [];
  }
  const lines = fs
    .readFileSync(reportPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // ignore partial trailing write
    }
  }
  return entries;
};

export const collectDesktopE2EReportState = (reportPath) => {
  const entries = readDesktopE2EReportEntries(reportPath);
  const eventTypes = entries.map((entry) => entry?.type);
  return {
    entries,
    eventTypes,
    missingEvents: requiredDesktopE2EEvents.filter((eventType) => !eventTypes.includes(eventType)),
    rendererReady: entries.find((entry) => entry?.type === 'renderer-bootstrap-ready') || null,
    bootstrapError: entries.find((entry) => entry?.type === 'renderer-bootstrap-error') || null,
  };
};
