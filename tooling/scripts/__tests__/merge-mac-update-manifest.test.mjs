import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { __test_only__ } from '../merge-mac-update-manifest.mjs';

const { readLatestMacYml, validateLatestMacYml, mergeLatestMacYamls } = __test_only__;

// ---- fixture（真实形状）----
// arm64 侧取自本机 electron-builder --mac zip --arm64 真实构建产物
// （dist-desktop/latest-mac.yml，2026-10-13，version 0.6.2）；
// x64 侧按同一形状推定（url/path 换 mac-x64，sha512/size 为合成值）。
const ARM64_YML = `version: 0.6.2
files:
  - url: IARTStudio-0.6.2-mac-arm64.zip
    sha512: dksWbk0Stz6tRbqXtKCSFivRj0Gc/GiQOgu1eKehlxzuKIQCC9loMKuLg2q0algujOKz47Pg8hVNrqnPVqPSTA==
    size: 286598868
path: IARTStudio-0.6.2-mac-arm64.zip
sha512: dksWbk0Stz6tRbqXtKCSFivRj0Gc/GiQOgu1eKehlxzuKIQCC9loMKuLg2q0algujOKz47Pg8hVNrqnPVqPSTA==
releaseDate: '2026-10-13T03:48:56.757Z'
`;

const makeX64Yml = (releaseDate = '2026-10-13T03:53:12.100Z', version = '0.6.2') => `version: ${version}
files:
  - url: IARTStudio-0.6.2-mac-x64.zip
    sha512: eE7Cdw1Xy2q3r4s5t6u7v8w9x0y1z2a3b4c5d6e7f8g9h0i1j2k3l4m5n6o7p8q9r0s1t2u3v4w5x6y7z8a==
    size: 311287420
path: IARTStudio-0.6.2-mac-x64.zip
sha512: eE7Cdw1Xy2q3r4s5t6u7v8w9x0y1z2a3b4c5d6e7f8g9h0i1j2k3l4m5n6o7p8q9r0s1t2u3v4w5x6y7z8a==
releaseDate: '${releaseDate}'
`;

const writeTmpYml = (content) => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-mac-yml-'));
  const file = join(dir, 'latest-mac.yml');
  writeFileSync(file, content);
  return { dir, file };
};

test('mergeLatestMacYamls: files 按 url union 且 arm64 在前；顶层主条目取 arm64', () => {
  const arm64 = yaml.load(ARM64_YML);
  const x64 = yaml.load(makeX64Yml());
  const merged = mergeLatestMacYamls(arm64, x64);

  assert.equal(merged.version, '0.6.2');
  assert.deepEqual(
    merged.files.map((f) => f.url),
    ['IARTStudio-0.6.2-mac-arm64.zip', 'IARTStudio-0.6.2-mac-x64.zip'],
  );
  // 顶层 path/sha512 = arm64 主条目（electron-updater 兼容投影）
  assert.equal(merged.path, 'IARTStudio-0.6.2-mac-arm64.zip');
  assert.equal(merged.sha512, arm64.sha512);
  // releaseDate 取新者（x64 构建在后）
  assert.equal(merged.releaseDate, '2026-10-13T03:53:12.100Z');
});

test('mergeLatestMacYamls: arm64 侧 releaseDate 较新时顶层取 arm64', () => {
  const arm64 = yaml.load(ARM64_YML);
  const x64 = yaml.load(makeX64Yml('2026-10-13T03:00:00.000Z'));
  const merged = mergeLatestMacYamls(arm64, x64);
  assert.equal(merged.releaseDate, '2026-10-13T03:48:56.757Z');
});

test('mergeLatestMacYamls: version 不一致取 releaseDate 新者一侧', () => {
  const arm64 = yaml.load(ARM64_YML);
  const x64 = yaml.load(makeX64Yml('2026-10-13T03:53:12.100Z', '0.6.3'));
  const merged = mergeLatestMacYamls(arm64, x64);
  assert.equal(merged.version, '0.6.3');
  assert.equal(merged.releaseDate, '2026-10-13T03:53:12.100Z');
});

test('mergeLatestMacYamls: 同 url 同内容去重', () => {
  const arm64 = yaml.load(ARM64_YML);
  const x64 = {
    ...yaml.load(makeX64Yml()),
    files: [...yaml.load(makeX64Yml()).files, { ...arm64.files[0] }],
  };
  const merged = mergeLatestMacYamls(arm64, x64);
  assert.equal(merged.files.length, 2);
});

test('mergeLatestMacYamls: 同 url 异内容抛错', () => {
  const arm64 = yaml.load(ARM64_YML);
  const x64 = {
    ...yaml.load(makeX64Yml()),
    files: [...yaml.load(makeX64Yml()).files, { ...arm64.files[0], size: 1 }],
  };
  assert.throws(() => mergeLatestMacYamls(arm64, x64), /url 冲突/);
});

test('validateLatestMacYml: 缺 files / size 非数字 / releaseDate 不可解析各报一题', () => {
  assert.ok(validateLatestMacYml({}).some((p) => /files/.test(p)));
  assert.ok(
    validateLatestMacYml({
      version: '1', releaseDate: '2026-01-01T00:00:00.000Z', path: 'a.zip', sha512: 's',
      files: [{ url: 'a.zip', sha512: 's', size: 'big' }],
    }).some((p) => /size/.test(p)),
  );
  assert.ok(
    validateLatestMacYml({
      version: '1', releaseDate: 'not-a-time', path: 'a.zip', sha512: 's',
      files: [{ url: 'a.zip', sha512: 's', size: 1 }],
    }).some((p) => /releaseDate/.test(p)),
  );
});

test('readLatestMacYml: 真实形状文件可读取；YAML dump→load 往返保形', () => {
  const { dir, file } = writeTmpYml(ARM64_YML);
  try {
    const doc = readLatestMacYml(file);
    assert.equal(doc.version, '0.6.2');
    assert.equal(doc.files[0].url, 'IARTStudio-0.6.2-mac-arm64.zip');

    const merged = mergeLatestMacYamls(doc, yaml.load(makeX64Yml()));
    const dumped = yaml.dump(merged, { lineWidth: 120 });
    const roundTrip = yaml.load(dumped);
    assert.deepEqual(roundTrip, merged);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
