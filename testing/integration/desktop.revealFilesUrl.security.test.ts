// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RevealShell {
  showItemInFolder(path: string): void;
  openPath(path: string): Promise<string>;
}

interface RevealFilesUrlArgs {
  url: string;
  storedProjectPath: string;
  shell: RevealShell;
  urlResolverRegistry: unknown;
}

type RevealFilesUrlResult =
  | { ok: true; fileKey: string }
  | { ok: false; reason: string };

describe('desktop/reveal/revealFilesUrl.cjs', () => {
  let tempRoot: string;
  let projectPath: string;
  let mediaDir: string;
  let registry: unknown;
  let calls: Array<[string, string]>;
  let shell: RevealShell;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null;

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-reveal-files-url-test-'));
    projectPath = path.join(tempRoot, 'demo.iarts');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.writeFileSync(path.join(projectPath, 'manifest.json'), JSON.stringify({}), 'utf-8');

    mediaDir = path.join(projectPath, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const { createDefaultUrlResolverRegistry } = await import('../../apps/desktop-shell/dist/reveal/urlResolverRegistry.cjs') as {
      createDefaultUrlResolverRegistry: () => unknown;
    };
    registry = createDefaultUrlResolverRegistry();

    calls = [];
    shell = {
      showItemInFolder: (p: string) => {
        calls.push(['showItemInFolder', p]);
      },
      openPath: async (p: string) => {
        calls.push(['openPath', p]);
        return '';
      },
    };

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = null;
  });

  it('reveals an existing local-media item via shell.showItemInFolder', async () => {
    fs.writeFileSync(path.join(mediaDir, 'a.png'), 'x', 'utf-8');

    const { revealFilesUrl } = await import('../../apps/desktop-shell/dist/reveal/revealFilesUrl.cjs') as {
      revealFilesUrl: (args: RevealFilesUrlArgs) => Promise<RevealFilesUrlResult>;
    };
    const result = await revealFilesUrl({
      url: 'local-media://__global__/a.png',
      storedProjectPath: projectPath,
      shell,
      urlResolverRegistry: registry,
    });

    expect(result.ok).toBe(true);
    expect(result.fileKey).toBe('a.png');
    expect(calls[0]?.[0]).toBe('showItemInFolder');
  });

  it('does not open any directory for non-local-media urls', async () => {
    const { revealFilesUrl } = await import('../../apps/desktop-shell/dist/reveal/revealFilesUrl.cjs') as {
      revealFilesUrl: (args: RevealFilesUrlArgs) => Promise<RevealFilesUrlResult>;
    };
    const result = await revealFilesUrl({
      url: 'https://example.com/assets/a.png',
      storedProjectPath: projectPath,
      shell,
      urlResolverRegistry: registry,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-files-url');
    expect(calls).toHaveLength(0);
  });

  it('rejects path traversal attempts and does not call shell', async () => {
    const { revealFilesUrl } = await import('../../apps/desktop-shell/dist/reveal/revealFilesUrl.cjs') as {
      revealFilesUrl: (args: RevealFilesUrlArgs) => Promise<RevealFilesUrlResult>;
    };
    const result = await revealFilesUrl({
      url: 'local-media://__global__/%2e%2e%2fsecret.txt',
      storedProjectPath: projectPath,
      shell,
      urlResolverRegistry: registry,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsafe-file-key');
    expect(calls).toHaveLength(0);
  });

  it('falls back to open media dir when file is missing', async () => {
    const { revealFilesUrl } = await import('../../apps/desktop-shell/dist/reveal/revealFilesUrl.cjs') as {
      revealFilesUrl: (args: RevealFilesUrlArgs) => Promise<RevealFilesUrlResult>;
    };
    const result = await revealFilesUrl({
      url: 'local-media://__global__/missing.png',
      storedProjectPath: projectPath,
      shell,
      urlResolverRegistry: registry,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-found');
    expect(calls[0]).toEqual(['openPath', mediaDir]);
  });
});
