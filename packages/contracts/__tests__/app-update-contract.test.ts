import { describe, expect, it } from 'vitest';

import {
  AppUpdateCheckRequestSchema,
  AppUpdateCheckResponseSchema,
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
});
