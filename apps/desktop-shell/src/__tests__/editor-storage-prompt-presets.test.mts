// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const desktopPromptPresetsEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-prompt-presets.cjs`;

type PromptPresetItem = {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
};

type PromptPresetsModule = {
  setPresetsFilePath: (filePath: string) => void;
  listPromptPresets: () => PromptPresetItem[];
  getPromptPreset: (id: unknown) => PromptPresetItem | null;
  createPromptPreset: (payload: { name: unknown; content: unknown }) => PromptPresetItem | null;
  updatePromptPreset: (
    id: unknown,
    updates: { name: unknown; content: unknown },
  ) => PromptPresetItem | null;
  deletePromptPreset: (id: unknown) => boolean;
};

const loadPromptPresetsModule = (): PromptPresetsModule =>
  requireDesktop(desktopPromptPresetsEntry) as PromptPresetsModule;

const loadFreshPromptPresetsModule = (): PromptPresetsModule => {
  const resolved = requireDesktop.resolve(desktopPromptPresetsEntry);
  delete requireDesktop.cache[resolved];
  return loadPromptPresetsModule();
};

describe('editor storage prompt presets', () => {
  const tempDirs: string[] = [];

  beforeAll(() => {
    if (!existsSync(desktopPromptPresetsEntry)) {
      execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
      });
    }
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  const useIsolatedPresetsFile = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'iart-prompt-presets-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'config', 'prompt-presets.json');
    const presets = loadPromptPresetsModule();
    presets.setPresetsFilePath(filePath);
    return { presets, filePath };
  };

  it('creates a preset and persists it to the JSON index file', () => {
    const { presets, filePath } = useIsolatedPresetsFile();

    const created = presets.createPromptPreset({ name: '  赛博朋克分镜  ', content: ' neon city ' });
    expect(created).not.toBeNull();
    expect(created).toMatchObject({ name: '赛博朋克分镜', content: 'neon city' });
    expect(typeof created?.id).toBe('string');
    expect(created?.id.length).toBeGreaterThan(0);
    expect(created?.createdAt).toBeGreaterThan(0);
    expect(created?.updatedAt).toBe(created?.createdAt);

    expect(existsSync(filePath)).toBe(true);
    const rawIndex = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      version: number;
      updatedAt: string;
      presets: PromptPresetItem[];
    };
    expect(rawIndex.version).toBe(1);
    expect(rawIndex.presets).toHaveLength(1);
    expect(rawIndex.presets[0]).toMatchObject({ id: created?.id, name: '赛博朋克分镜' });
  });

  it('rejects create payloads with blank name or content', () => {
    const { presets, filePath } = useIsolatedPresetsFile();

    expect(presets.createPromptPreset({ name: '   ', content: 'x' })).toBeNull();
    expect(presets.createPromptPreset({ name: 'x', content: '' })).toBeNull();
    expect(presets.createPromptPreset({ name: undefined, content: 'x' })).toBeNull();
    expect(existsSync(filePath)).toBe(false);
    expect(presets.listPromptPresets()).toEqual([]);
  });

  it('lists presets sorted by updatedAt desc and reads one by id', () => {
    const { presets } = useIsolatedPresetsFile();

    const first = presets.createPromptPreset({ name: '甲', content: 'alpha' });
    const second = presets.createPromptPreset({ name: '乙', content: 'beta' });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const listed = presets.listPromptPresets();
    expect(listed.map((item) => item.id)).toEqual([second?.id, first?.id]);
    expect(presets.getPromptPreset(first?.id)).toMatchObject({ name: '甲', content: 'alpha' });
    expect(presets.getPromptPreset('missing-id')).toBeNull();
    expect(presets.getPromptPreset('')).toBeNull();
  });

  it('updates name/content, bumps updatedAt and keeps id/createdAt', () => {
    const { presets } = useIsolatedPresetsFile();

    const created = presets.createPromptPreset({ name: '旧名', content: 'old' });
    expect(created).not.toBeNull();

    const updated = presets.updatePromptPreset(created?.id, { name: ' 新名 ', content: ' new ' });
    expect(updated).toMatchObject({
      id: created?.id,
      name: '新名',
      content: 'new',
      createdAt: created?.createdAt,
    });
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(created?.updatedAt ?? 0);

    const listed = presets.listPromptPresets();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created?.id, name: '新名', content: 'new' });

    expect(presets.updatePromptPreset('missing-id', { name: 'x', content: 'y' })).toBeNull();
    expect(presets.updatePromptPreset(created?.id, { name: '', content: 'y' })).toBeNull();
    expect(presets.listPromptPresets()[0]).toMatchObject({ name: '新名' });
  });

  it('deletes an existing preset and reports misses as false', () => {
    const { presets } = useIsolatedPresetsFile();

    const created = presets.createPromptPreset({ name: '待删', content: 'bye' });
    expect(created).not.toBeNull();

    expect(presets.deletePromptPreset(created?.id)).toBe(true);
    expect(presets.listPromptPresets()).toEqual([]);
    expect(presets.getPromptPreset(created?.id)).toBeNull();
    expect(presets.deletePromptPreset(created?.id)).toBe(false);
    expect(presets.deletePromptPreset('')).toBe(false);
  });

  it('reads back persisted presets with a freshly loaded module instance', () => {
    const { presets, filePath } = useIsolatedPresetsFile();

    const created = presets.createPromptPreset({ name: '持久化', content: 'survive reload' });
    expect(created).not.toBeNull();

    const fresh = loadFreshPromptPresetsModule();
    fresh.setPresetsFilePath(filePath);
    expect(fresh.listPromptPresets()).toEqual([
      expect.objectContaining({ id: created?.id, name: '持久化', content: 'survive reload' }),
    ]);
    expect(fresh.getPromptPreset(created?.id)).toMatchObject({ createdAt: created?.createdAt });
  });
});
