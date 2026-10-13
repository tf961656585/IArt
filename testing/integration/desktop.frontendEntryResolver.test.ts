// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const loadModule = () =>
  import('../../apps/desktop-shell/dist/window/frontend-entry-resolver.cjs') as Promise<{
    resolveEditorWindowTarget: (options: {
      devUrl?: string | null;
      backendBaseUrl?: string | null;
      staticRoot?: string;
    }) => string | null;
    resolveHubWindowTarget: (options: { devUrl?: string | null; staticRoot: string }) => string | null;
  }>;

const tempDirs: string[] = [];

const createStaticRoot = (entries: string[]) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iarts-static-root-'));
  tempDirs.push(root);
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, '<html></html>', 'utf8');
  }
  return root;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('desktop/window/frontend-entry-resolver.cjs', () => {
  it('Hub 优先走 dev URL，否则回退到本地静态入口', async () => {
    const { resolveHubWindowTarget } = await loadModule();
    const staticRoot = createStaticRoot(['index.html']);
    expect(
      resolveHubWindowTarget({
        devUrl: 'http://127.0.0.1:3200',
        staticRoot,
      }),
    ).toBe('http://127.0.0.1:3200/');

    const fallback = resolveHubWindowTarget({
      devUrl: '',
      staticRoot,
    });
    expect(fallback?.startsWith('file://')).toBe(true);
    expect(fallback).toContain('/index.html');
  });

  it('Editor 生产态固定落到 backend HTTP /editor/ 入口', async () => {
    const { resolveEditorWindowTarget } = await loadModule();
    const target = resolveEditorWindowTarget({
      backendBaseUrl: 'http://127.0.0.1:39000',
    });

    expect(target).toBe('http://127.0.0.1:39000/editor/');
  });

  it('Editor 开发态只加载 dev server 根入口，不再表达页面文件路径', async () => {
    const { resolveEditorWindowTarget } = await loadModule();
    const staticRoot = createStaticRoot(['index.html']);
    const target = resolveEditorWindowTarget({
      devUrl: 'http://127.0.0.1:3300/editor-dev?legacy=1',
      staticRoot,
    });

    expect(target).toBe('http://127.0.0.1:3300/');
  });

  it('Editor dev URL 传入 file:// 时必须回退到 backend HTTP /editor/ 入口', async () => {
    const { resolveEditorWindowTarget } = await loadModule();
    const staticRoot = createStaticRoot(['index.html']);
    const target = resolveEditorWindowTarget({
      devUrl: 'file:///tmp/editor/index.html',
      backendBaseUrl: 'http://127.0.0.1:39000',
      staticRoot,
    });

    expect(target).toBe('http://127.0.0.1:39000/editor/');
  });

  it('Editor dev URL 传入 file:// 且无 backendBaseUrl 时返回 null', async () => {
    const { resolveEditorWindowTarget } = await loadModule();
    const staticRoot = createStaticRoot(['index.html']);
    const target = resolveEditorWindowTarget({
      devUrl: 'file:///tmp/editor/index.html',
      staticRoot,
    });

    expect(target).toBeNull();
  });
});
