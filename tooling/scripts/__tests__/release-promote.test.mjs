// release-promote 纯函数测试：feed 版本解析、tag 版本归一、feed 文件清单、基址读取，
// 以及转正路径的纯逻辑（在制版本一致性、tag 落点裁决与幂等/冲突）。
// 网络探测与 gh 交互不在单测范围（生成物形态验证走真实 --verify-only，见批次收尾）。
// 纪律：本文件不得钉死根 package.json 的实际版本值（测试一律用夹具假值）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test_only__ } from '../release-promote.mjs';

const {
  parseFeedVersion,
  readFeedBaseUrl,
  normalizeVersion,
  FEED_FILES,
  readPackageVersion,
  assertPromotable,
  assertReleasePublished,
  assertLatestRelease,
  findExactTagRef,
  resolveTagAction,
} = __test_only__;

test('parseFeedVersion 解析 electron-builder latest.yml 形状', () => {
  const sample = [
    'version: 0.6.11',
    'files:',
    '  - url: IARTStudio-Setup-0.6.11-x64.exe',
    '    sha512: abc==',
    '    size: 123',
    'path: IARTStudio-Setup-0.6.11-x64.exe',
    'sha512: abc==',
    "releaseDate: '2026-10-16T01:28:29.000Z'",
  ].join('\n');
  assert.equal(parseFeedVersion(sample), '0.6.11');
});

test('parseFeedVersion 对缺 version、空文本、非映射输入返回 null', () => {
  assert.equal(parseFeedVersion('files: []'), null);
  assert.equal(parseFeedVersion(''), null);
  assert.equal(parseFeedVersion('- a\n- b'), null);
  assert.equal(parseFeedVersion('version:   '), null);
});

test('normalizeVersion 剥离 tag 的 v 前缀', () => {
  assert.equal(normalizeVersion('v0.6.11'), '0.6.11');
  assert.equal(normalizeVersion('0.6.11'), '0.6.11');
});

test('FEED_FILES 覆盖三平台 feed 文件', () => {
  assert.deepEqual(FEED_FILES, ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']);
});

test('readFeedBaseUrl 读 generic provider url 并去尾斜杠（夹具用保留域名）', () => {
  const base = readFeedBaseUrl({
    build: { publish: { provider: 'generic', url: 'https://example.com/releases/latest/download/' } },
  });
  assert.equal(base, 'https://example.com/releases/latest/download');
});

test('readFeedBaseUrl 对非 generic provider 或缺 url 抛错', () => {
  assert.throws(
    () => readFeedBaseUrl({ build: { publish: { provider: 'github', owner: 'example', repo: 'example' } } }),
    /feed 基址/,
  );
  assert.throws(() => readFeedBaseUrl({ build: {} }), /feed 基址/);
});

test('readPackageVersion 读夹具 version 并去空白', () => {
  assert.equal(readPackageVersion({ version: '9.9.9' }), '9.9.9');
  assert.equal(readPackageVersion({ version: ' 9.9.9 ' }), '9.9.9');
});

test('readPackageVersion 对缺 version、非字符串、非法容器抛错', () => {
  assert.throws(() => readPackageVersion({}), /version/);
  assert.throws(() => readPackageVersion({ version: 999 }), /version/);
  assert.throws(() => readPackageVersion({ version: '   ' }), /version/);
  assert.throws(() => readPackageVersion(null), /version/);
});

test('assertPromotable：package.json version 与 tag（去 v）一致时放行', () => {
  assert.doesNotThrow(() => assertPromotable('v9.9.9', '9.9.9'));
  assert.doesNotThrow(() => assertPromotable('9.9.9', '9.9.9'));
});

test('assertPromotable：版本不一致 / 空版本拒绝转正', () => {
  assert.throws(() => assertPromotable('v9.9.9', '9.9.10'), /拒绝转正/);
  assert.throws(() => assertPromotable('v9.9.9', ''), /拒绝转正/);
  assert.throws(() => assertPromotable('v9.9.9', undefined), /拒绝转正/);
});

test('findExactTagRef 精确匹配 refs/tags/<tag>，前缀同名（v9.9.9 对 v9.9.90）不误命中', () => {
  const refs = [
    { ref: 'refs/tags/v9.9.90', object: { sha: 'bbb', type: 'commit' } },
    { ref: 'refs/tags/v9.9.9', object: { sha: 'aaa', type: 'commit' } },
  ];
  const found = findExactTagRef(refs, 'v9.9.9');
  assert.equal(found.object.sha, 'aaa');
  assert.equal(findExactTagRef([{ ref: 'refs/tags/v9.9.90' }], 'v9.9.9'), null);
  assert.equal(findExactTagRef([], 'v9.9.9'), null);
  assert.equal(findExactTagRef(null, 'v9.9.9'), null);
});

test('assertReleasePublished：非草稿且非预发布才放行', () => {
  assert.doesNotThrow(() => assertReleasePublished({ isDraft: false, isPrerelease: false, tagName: 'v9.9.9' }, 'v9.9.9'));
});

test('assertReleasePublished：预发布标记残留判红并给出取消勾选/命令两条修复路径', () => {
  assert.throws(
    () => assertReleasePublished({ isDraft: false, isPrerelease: true, tagName: 'v9.9.9' }, 'v9.9.9'),
    /预发布/,
  );
  assert.throws(
    () => assertReleasePublished({ isDraft: false, isPrerelease: true, tagName: 'v9.9.9' }, 'v9.9.9'),
    /--prerelease=false/,
  );
});

test('assertReleasePublished：草稿、未知状态、tag 不一致均拒绝放行', () => {
  assert.throws(() => assertReleasePublished({ isDraft: true, isPrerelease: false, tagName: 'v9.9.9' }, 'v9.9.9'), /草稿/);
  assert.throws(() => assertReleasePublished({}, 'v9.9.9'), /草稿/);
  assert.throws(() => assertReleasePublished(null, 'v9.9.9'), /草稿/);
  assert.throws(
    () => assertReleasePublished({ isDraft: false, isPrerelease: false, tagName: 'v9.9.10' }, 'v9.9.9'),
    /不一致/,
  );
});

test('assertLatestRelease：最新正式发布指向本 tag 才放行', () => {
  assert.doesNotThrow(() => assertLatestRelease('v9.9.9', 'v9.9.9'));
  assert.doesNotThrow(() => assertLatestRelease(' v9.9.9 ', 'v9.9.9'));
});

test('assertLatestRelease：无最新正式发布（404）或指向别的 tag 时判红', () => {
  assert.throws(() => assertLatestRelease(null, 'v9.9.9'), /最新正式发布/);
  assert.throws(() => assertLatestRelease('', 'v9.9.9'), /最新正式发布/);
  assert.throws(() => assertLatestRelease(undefined, 'v9.9.9'), /最新正式发布/);
  assert.throws(() => assertLatestRelease('v9.9.8', 'v9.9.9'), /指向 v9\.9\.8/);
});

test('resolveTagAction：tag 不存在→create；同提交→skip（幂等）', () => {
  assert.equal(resolveTagAction(null, 'aaa'), 'create');
  assert.equal(resolveTagAction(undefined, 'aaa'), 'create');
  assert.equal(resolveTagAction('aaa', 'aaa'), 'skip');
  assert.equal(resolveTagAction(' aaa ', 'aaa'), 'skip');
});

test('resolveTagAction：tag 指向不同提交时拒绝覆盖', () => {
  assert.throws(() => resolveTagAction('bbb', 'aaa'), /不一致/);
  assert.throws(() => resolveTagAction('bbb', 'aaa'), /拒绝覆盖/);
});

test('resolveTagAction：草稿缺 targetCommitish 时拒绝落 tag', () => {
  assert.throws(() => resolveTagAction(null, ''), /targetCommitish/);
  assert.throws(() => resolveTagAction('aaa', undefined), /targetCommitish/);
});
