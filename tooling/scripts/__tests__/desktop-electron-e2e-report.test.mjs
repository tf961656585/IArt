import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectDesktopE2EReportState,
  readDesktopE2EReportEntries,
  requiredDesktopE2EEvents,
} from '../desktop-electron-e2e-report.mjs';

const appendEvent = (reportPath, type, detail = undefined) => {
  fs.appendFileSync(
    reportPath,
    `${JSON.stringify({ type, ...(detail === undefined ? {} : { detail }), at: Date.now() })}\n`,
    'utf8',
  );
};

test('desktop electron e2e report waits for all required host-chain events', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-e2e-report-'));
  const reportPath = path.join(tempDir, 'report.jsonl');

  for (const eventType of requiredDesktopE2EEvents.filter((eventType) => eventType !== 'hub-window-loaded')) {
    appendEvent(reportPath, eventType);
  }

  const beforeHubLoaded = collectDesktopE2EReportState(reportPath);
  assert.deepEqual(beforeHubLoaded.missingEvents, ['hub-window-loaded']);
  assert.equal(beforeHubLoaded.rendererReady?.type, 'renderer-bootstrap-ready');

  appendEvent(reportPath, 'hub-window-loaded', { url: 'http://127.0.0.1:39000/hub/' });
  const afterHubLoaded = collectDesktopE2EReportState(reportPath);
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert.deepEqual(afterHubLoaded.missingEvents, []);
});

test('desktop electron e2e report ignores partial trailing JSON writes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-e2e-report-partial-'));
  const reportPath = path.join(tempDir, 'report.jsonl');
  appendEvent(reportPath, 'app-ready');
  fs.appendFileSync(reportPath, '{"type":"backend-listening"', 'utf8');

  const entries = readDesktopE2EReportEntries(reportPath);
  fs.rmSync(tempDir, { recursive: true, force: true });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.type, 'app-ready');
});
