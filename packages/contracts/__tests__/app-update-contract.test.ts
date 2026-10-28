import { describe, expect, it } from 'vitest';

import {
  AppUpdateCheckRequestSchema,
  AppUpdateCheckResponseSchema,
  AppUpdateCommandResultSchema,
  AppUpdateEventSchema,
  AppUpdateReleaseManifestSchema,
  AppUpdateStateSchema,
} from '../src/app-update';

const releaseFile = {
  platform: 'darwin',
  arch: 'arm64',
  kind: 'installer',
  name: 'IARTStudio-0.5.1-mac-arm64.zip',
  path: 'versions/0.5.1/darwin-arm64/IARTStudio-0.5.1-mac-arm64.zip',
  r2Key: 'versions/0.5.1/darwin-arm64/IARTStudio-0.5.1-mac-arm64.zip',
  sha512: 'hash',
  size: 123,
  blockmapKey: 'versions/0.5.1/darwin-arm64/IARTStudio-0.5.1-mac-arm64.zip.blockmap',
};

const idleState = {
  status: 'idle',
  appVersion: '0.5.0',
  channel: 'stable',
  platform: 'darwin',
  arch: 'arm64',
  lastCheckedAt: null,
  logPath: null,
};

describe('app update contract schemas', () => {
  it('parses release manifests with platform and arch scoped files', () => {
    const manifest = AppUpdateReleaseManifestSchema.parse({
      schemaVersion: 1,
      channel: 'stable',
      version: '0.5.1',
      releaseDate: '2026-05-06T04:14:19.000Z',
      generatedAt: '2026-05-06T04:14:19.000Z',
      commitSha: 'abc',
      runId: 'run-1',
      files: [releaseFile],
      mandatory: false,
      minimumVersion: null,
      notes: null,
    });

    expect(manifest.files[0]?.platform).toBe('darwin');
    expect(manifest.files[0]?.arch).toBe('arm64');
  });

  it('rejects duplicated optional-state style snapshots without discriminant', () => {
    expect(
      AppUpdateStateSchema.safeParse({
        checking: false,
        downloaded: true,
        version: '0.5.1',
      }).success,
    ).toBe(false);

    expect(
      AppUpdateStateSchema.safeParse({
        status: 'downloaded',
        appVersion: '0.5.0',
        channel: 'stable',
        platform: 'darwin',
        arch: 'arm64',
        lastCheckedAt: 1,
        logPath: '/tmp/updater.log',
        latestVersion: '0.5.1',
        downloadPath: '/tmp/IARTStudio.dmg',
        files: [releaseFile],
        installActions: ['open-installer', 'show-in-folder', 'later'],
      }).success,
    ).toBe(true);
  });

  it('parses check request and response DTOs', () => {
    expect(
      AppUpdateCheckRequestSchema.parse({
        currentVersion: '0.5.0',
        platform: 'win32',
        arch: 'x64',
      }).channel,
    ).toBe('stable');

    expect(
      AppUpdateCheckResponseSchema.parse({
        updateAvailable: true,
        currentVersion: '0.5.0',
        latestVersion: '0.5.1',
        platform: 'darwin',
        arch: 'arm64',
        channel: 'stable',
        files: [releaseFile],
        mandatory: false,
        minimumVersion: null,
        notes: null,
        releaseDate: '2026-05-06T04:14:19.000Z',
        error: null,
      }).files.length,
    ).toBe(1);
  });

  it('parses skipped command results carrying retryAfterMs for throttled checks', () => {
    const result = AppUpdateCommandResultSchema.parse({
      status: 'skipped',
      reason: 'throttled',
      retryAfterMs: 42_000,
      state: idleState,
    });

    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('throttled');
      expect(result.retryAfterMs).toBe(42_000);
    }
  });

  it('rejects retryAfterMs on skipped results with negative or non-integer values', () => {
    expect(
      AppUpdateCommandResultSchema.safeParse({
        status: 'skipped',
        reason: 'throttled',
        retryAfterMs: -1,
        state: idleState,
      }).success,
    ).toBe(false);

    expect(
      AppUpdateCommandResultSchema.safeParse({
        status: 'skipped',
        reason: 'throttled',
        retryAfterMs: 1.5,
        state: idleState,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys on skipped command results (strict schema)', () => {
    expect(
      AppUpdateCommandResultSchema.safeParse({
        status: 'skipped',
        reason: 'throttled',
        retryAfterMs: 1000,
        retryAfterSeconds: 1,
        state: idleState,
      }).success,
    ).toBe(false);
  });

  it('keeps the update state discriminant set unchanged (no check-error / download-error enums)', () => {
    const statuses = [
      'idle',
      'checking',
      'not-available',
      'available',
      'downloading',
      'downloaded',
      'error',
    ] as const;

    for (const status of statuses) {
      const base = {
        appVersion: '0.5.0',
        channel: 'stable',
        platform: 'darwin',
        arch: 'arm64',
        lastCheckedAt: null,
        logPath: '/tmp/updater.log',
      } as const;
      const candidate =
        status === 'not-available'
          ? { ...base, status, latestVersion: null }
          : status === 'available'
            ? {
                ...base,
                status,
                latestVersion: '0.5.1',
                releaseDate: null,
                notes: null,
                files: [],
                mandatory: false,
                minimumVersion: null,
              }
            : status === 'downloading'
              ? { ...base, status, latestVersion: '0.5.1', progress: null }
              : status === 'downloaded'
                ? {
                    ...base,
                    status,
                    latestVersion: '0.5.1',
                    downloadPath: null,
                    files: [],
                    installActions: [],
                  }
                : status === 'error'
                  ? { ...base, status, latestVersion: null, error: { message: 'boom' } }
                  : { ...base, status };

      expect(AppUpdateStateSchema.safeParse(candidate).success).toBe(true);
      for (const rejected of ['check-error', 'download-error']) {
        expect(AppUpdateStateSchema.safeParse({ ...candidate, status: rejected }).success).toBe(false);
      }
    }

    const eventTypes = ['checking', 'available', 'not-available', 'download-progress', 'downloaded', 'error'] as const;
    for (const type of eventTypes) {
      expect(AppUpdateEventSchema.safeParse({ type, state: idleState }).success).toBe(true);
    }
    expect(AppUpdateEventSchema.safeParse({ type: 'cancel', state: idleState }).success).toBe(false);
  });
});
