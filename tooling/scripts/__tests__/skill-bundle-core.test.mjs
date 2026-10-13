import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSkillBundle,
  validateSkillBundle,
  validateSkillMeta,
  buildIndexJson,
  isSafeRelativePath,
  isAcceptableFile,
} from '../skill-bundle-core.mjs';

// ---- validateSkillMeta ----

test('validateSkillMeta: 合法元数据通过校验', () => {
  const result = validateSkillMeta({ id: 'gpt-image', version: '1.0.0', name: 'GPT Image', description: 'desc' });
  assert.equal(result.ok, true);
});

test('validateSkillMeta: 缺少 name 字段返回失败', () => {
  const result = validateSkillMeta({ id: 'x', version: '1', description: 'd' });
  assert.equal(result.ok, false);
  assert.match(result.message, /name/);
});

test('validateSkillMeta: 非对象返回失败', () => {
  assert.equal(validateSkillMeta([]).ok, false);
  assert.equal(validateSkillMeta(null).ok, false);
  assert.equal(validateSkillMeta('str').ok, false);
});

// ---- validateSkillBundle ----

test('validateSkillBundle: 合法 bundle 通过校验', () => {
  const bundle = {
    id: 'gpt-image',
    version: '1.0.0',
    files: [{ path: 'SKILL.md', content: 'x', executable: false }],
  };
  assert.equal(validateSkillBundle(bundle).ok, true);
});

test('validateSkillBundle: 空 files 数组返回失败', () => {
  const result = validateSkillBundle({ id: 'x', version: '1', files: [] });
  assert.equal(result.ok, false);
  assert.match(result.message, /files/);
});

test('validateSkillBundle: 含 .. 穿越路径的 bundle 返回失败', () => {
  const bundle = {
    id: 'x',
    version: '1',
    files: [{ path: '../evil.sh', content: 'x', executable: true }],
  };
  const result = validateSkillBundle(bundle);
  assert.equal(result.ok, false);
  assert.match(result.message, /evil\.sh/);
});

test('validateSkillBundle: 绝对路径返回失败', () => {
  const bundle = {
    id: 'x',
    version: '1',
    files: [{ path: '/etc/passwd', content: 'x', executable: false }],
  };
  assert.equal(validateSkillBundle(bundle).ok, false);
});

test('validateSkillBundle: executable 非布尔返回失败', () => {
  const bundle = {
    id: 'x',
    version: '1',
    files: [{ path: 'a.sh', content: 'x', executable: 'yes' }],
  };
  assert.equal(validateSkillBundle(bundle).ok, false);
});

// ---- isSafeRelativePath ----

test('isSafeRelativePath: 拒绝绝对路径与 .. 穿越', () => {
  assert.equal(isSafeRelativePath('../evil'), false);
  assert.equal(isSafeRelativePath('/abs/path'), false);
  assert.equal(isSafeRelativePath('a/../../b'), false);
});

test('isSafeRelativePath: 接受合法相对路径', () => {
  assert.equal(isSafeRelativePath('SKILL.md'), true);
  assert.equal(isSafeRelativePath('scripts/x.sh'), true);
  assert.equal(isSafeRelativePath('a/b/c.json'), true);
});

// ---- isAcceptableFile ----

test('isAcceptableFile: 排除隐藏文件与 .DS_Store', () => {
  assert.equal(isAcceptableFile('.DS_Store'), false);
  assert.equal(isAcceptableFile('.hidden'), false);
  assert.equal(isAcceptableFile('SKILL.md'), true);
  assert.equal(isAcceptableFile('scripts/x.sh'), true);
});

// ---- buildSkillBundle（集成，用临时目录）----

test('buildSkillBundle: 正确打包目录并标记可执行位', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'skill-test-'));
  try {
    mkdirSync(join(tmpDir, 'scripts'));
    writeFileSync(join(tmpDir, 'skill.json'), JSON.stringify({ id: 'test', version: '1.0.0', name: 'Test', description: 'd' }));
    writeFileSync(join(tmpDir, 'SKILL.md'), 'content');
    writeFileSync(join(tmpDir, 'scripts', 'run.sh'), '#!/bin/bash');
    writeFileSync(join(tmpDir, '.DS_Store'), 'should-be-excluded');

    const meta = { id: 'test', version: '1.0.0', name: 'Test', description: 'd' };
    const bundle = buildSkillBundle(tmpDir, meta);

    assert.equal(bundle.id, 'test');
    assert.equal(bundle.version, '1.0.0');
    // .DS_Store 应被排除，剩 2 个文件（skill.json 不在收集范围？实际在——collectSkillFiles 收集所有文件）
    // 收集的是目录下所有文件：skill.json, SKILL.md, scripts/run.sh（.DS_Store 排除）
    assert.equal(bundle.files.length, 3);
    const paths = bundle.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['SKILL.md', 'scripts/run.sh', 'skill.json']);
    const shFile = bundle.files.find((f) => f.path === 'scripts/run.sh');
    assert.equal(shFile.executable, true);
    const mdFile = bundle.files.find((f) => f.path === 'SKILL.md');
    assert.equal(mdFile.executable, false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildSkillBundle: 空目录抛错', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'skill-empty-'));
  try {
    assert.throws(() => buildSkillBundle(tmpDir, { id: 'x', version: '1' }), /无可打包文件/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildSkillBundle: 缺少 id 的 meta 抛错', () => {
  assert.throws(() => buildSkillBundle('.', { version: '1' }), /id/);
});

// ---- buildIndexJson ----

test('buildIndexJson: 首次发布创建单条目目录', () => {
  const meta = { id: 'gpt-image', version: '1.0.0', name: 'GPT Image', description: 'desc' };
  const idx = buildIndexJson(null, meta, 'skills/bundles/gpt-image-1.0.0.json', 'sha512hex');
  assert.equal(idx.version, 1);
  assert.equal(idx.skills.length, 1);
  assert.equal(idx.skills[0].id, 'gpt-image');
  assert.equal(idx.skills[0].bundleKey, 'skills/bundles/gpt-image-1.0.0.json');
});

test('buildIndexJson: 同 id 覆盖而非追加', () => {
  const existing = {
    version: 1,
    skills: [
      { id: 'gpt-image', name: 'Old', version: '0.9', description: 'd', bundleKey: 'old-key', sha512: 'old-sha' },
      { id: 'other', name: 'Other', version: '1', description: 'd', bundleKey: 'k2', sha512: 's2' },
    ],
  };
  const meta = { id: 'gpt-image', version: '1.0.0', name: 'GPT Image', description: 'new' };
  const idx = buildIndexJson(existing, meta, 'new-key', 'new-sha');
  assert.equal(idx.skills.length, 2); // 覆盖而非追加
  const gpt = idx.skills.find((s) => s.id === 'gpt-image');
  assert.equal(gpt.version, '1.0.0');
  assert.equal(gpt.bundleKey, 'new-key');
});

test('buildIndexJson: 新 id 追加到现有目录', () => {
  const existing = {
    version: 1,
    skills: [{ id: 'old', name: 'Old', version: '1', description: 'd', bundleKey: 'k', sha512: 's' }],
  };
  const meta = { id: 'new', version: '1.0.0', name: 'New', description: 'new' };
  const idx = buildIndexJson(existing, meta, 'new-key', 'new-sha');
  assert.equal(idx.skills.length, 2);
  assert.deepEqual(idx.skills.map((s) => s.id), ['old', 'new']);
});
