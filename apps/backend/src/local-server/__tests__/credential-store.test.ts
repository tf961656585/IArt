import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireLease,
  clearCacheForTest,
  readCredentialValue,
  setCredentialCryptoProvider,
  setCredentialForConnection,
} from '../provider-connection/credential-store.cts';

/**
 * 凭证条目「自描述加密方案」读写语义（2026-10-29 事故修复）。
 *
 * 事故：安装版读取开发版写入的凭证时 safeStorage 解密失败（钥匙串授权只登记了开发目录的
 * Electron），旧实现 `decryptPayload` 用空 catch 吞掉失败后把**密文**按 base64 当明文返回，
 * 于是 `Authorization: Bearer <乱码>` 被上游拒绝，任务以 `task_execution_unexpected_error`
 * + 英文原文失败，全链零日志。
 *
 * 本文件守住的底线：**不可读的凭证绝不产出任何可当明文使用的字符串**；读取只按 scheme
 * 解释，不做「解密失败就回退 base64」的猜测；失败留痕可投影（lastReadFailureAt）。
 */

const CONNECTION_ID = 'up_conn_credential_scheme';
const CREDENTIAL_REF = `cred_${CONNECTION_ID}`;
const CIPHERTEXT_MARKER = 'v10-this-is-not-plaintext';
const PLAINTEXT_VALUE = 'sk-plaintext-value';

const withIsolatedRoot = (t: test.TestContext): string => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-store-'));
  const previousRoot = process.env['IART_STORAGE_ROOT'];
  process.env['IART_STORAGE_ROOT'] = storageRoot;
  clearCacheForTest();
  t.after(() => {
    setCredentialCryptoProvider(null);
    clearCacheForTest();
    if (previousRoot === undefined) delete process.env['IART_STORAGE_ROOT'];
    else process.env['IART_STORAGE_ROOT'] = previousRoot;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });
  return storageRoot;
};

/** 写入凭证文件条目（模拟历史文件 / 跨安装目录写入的 safeStorage 密文）。 */
const writeCredentialFixture = (
  storageRoot: string,
  entry: Record<string, unknown>,
): void => {
  fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, 'config', 'provider-credentials.json'),
    JSON.stringify({
      version: 1,
      updatedAt: '2026-10-29T00:00:00.000Z',
      entries: { [CREDENTIAL_REF]: { version: 1, updatedAt: '2026-10-29T00:00:00.000Z', ...entry } },
    }, null, 2),
    'utf-8',
  );
};

const readCredentialFile = (storageRoot: string): Record<string, unknown> => {
  const raw = fs.readFileSync(path.join(storageRoot, 'config', 'provider-credentials.json'), 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
};

const readEntry = (storageRoot: string): Record<string, unknown> => {
  const entries = readCredentialFile(storageRoot).entries;
  assert.ok(entries !== null && typeof entries === 'object', 'entries must be an object');
  const entry = (entries as Record<string, unknown>)[CREDENTIAL_REF];
  assert.ok(entry !== null && typeof entry === 'object', 'fixture entry must exist');
  return entry as Record<string, unknown>;
};

/** 会抛错的宿主安全存储替身（模拟钥匙串授权失效 / 跨安装目录解密失败）。 */
const installThrowingProvider = (): void => {
  setCredentialCryptoProvider({
    encryptString: async (value: string) => Buffer.from(value, 'utf8'),
    decryptString: async () => {
      throw new Error('Error: Error while decoding data from safeStorage ByteString');
    },
    isEncryptionAvailable: async () => true,
  });
};

/** 可用的宿主安全存储替身（确定性变换，便于断言条目 scheme）。 */
const installWorkingProvider = (): void => {
  setCredentialCryptoProvider({
    encryptString: async (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: async (buffer: Buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('unexpected ciphertext');
      return text.slice('enc:'.length);
    },
    isEncryptionAvailable: async () => true,
  });
};

void test('解密失败不得产出伪明文：scheme=os_safe_storage + provider 抛错 → 不可读', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  const payload = Buffer.from(CIPHERTEXT_MARKER, 'utf8').toString('base64');
  writeCredentialFixture(storageRoot, { payload, scheme: 'os_safe_storage' });
  installThrowingProvider();

  const result = await readCredentialValue(CREDENTIAL_REF);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'unreadable');
  // 返回值里绝不含密文任何片段（旧实现把 base64 解码后的密文当明文返回）。
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(CIPHERTEXT_MARKER), false);
  assert.equal(serialized.includes(payload), false);
});

void test('scheme=os_safe_storage + provider 正常 → 读出明文，且条目自描述 scheme', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  installWorkingProvider();
  const written = await setCredentialForConnection(CONNECTION_ID, PLAINTEXT_VALUE);
  assert.ok(written, 'credential should be written');
  assert.equal(readEntry(storageRoot).scheme, 'os_safe_storage', '写入时按实际方案落 scheme');

  const result = await readCredentialValue(CREDENTIAL_REF);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, PLAINTEXT_VALUE);
});

void test('历史条目（无 scheme）v10 前缀 + provider 抛错 → 不可读，绝不回退 base64', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  const payload = Buffer.from(`${CIPHERTEXT_MARKER}-legacy`, 'utf8').toString('base64');
  writeCredentialFixture(storageRoot, { payload });
  installThrowingProvider();

  const result = await readCredentialValue(CREDENTIAL_REF);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'unreadable');
  assert.equal(JSON.stringify(result).includes(CIPHERTEXT_MARKER), false);
});

void test('历史条目（无 scheme）明文 base64 + 无 provider → 读出明文（既有 CI/mock 路径不回归）', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeCredentialFixture(storageRoot, {
    payload: Buffer.from(PLAINTEXT_VALUE, 'utf8').toString('base64'),
  });
  setCredentialCryptoProvider(null);

  const result = await readCredentialValue(CREDENTIAL_REF);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value, PLAINTEXT_VALUE);
});

void test('scheme=obfuscated 但 payload 解出非法 UTF-8 → 不可读', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  // 0xC3 0x28 是非法 UTF-8 序列；base64 本身合法。
  writeCredentialFixture(storageRoot, {
    payload: Buffer.from([0xc3, 0x28, 0xff, 0xfe]).toString('base64'),
    scheme: 'obfuscated',
  });

  const result = await readCredentialValue(CREDENTIAL_REF);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'unreadable');
});

void test('lastReadFailureAt：一次不可读置位、成功读取清除、重新保存清除', async (t) => {
  const storageRoot = withIsolatedRoot(t);
  writeCredentialFixture(storageRoot, {
    payload: Buffer.from([0xc3, 0x28]).toString('base64'),
    scheme: 'obfuscated',
  });

  const failed = await readCredentialValue(CREDENTIAL_REF);
  assert.equal(failed.ok, false);
  const firstFailureAt = readEntry(storageRoot).lastReadFailureAt;
  assert.equal(typeof firstFailureAt, 'string', '不可读必须置位 lastReadFailureAt');
  const updatedAtAfterFirstFailure = readCredentialFile(storageRoot).updatedAt;

  // 再次失败：状态未变化时不得重复写盘（updatedAt 不变）。
  const failedAgain = await readCredentialValue(CREDENTIAL_REF);
  assert.equal(failedAgain.ok, false);
  assert.equal(readEntry(storageRoot).lastReadFailureAt, firstFailureAt);
  assert.equal(readCredentialFile(storageRoot).updatedAt, updatedAtAfterFirstFailure);

  // 成功读取（改写为可读条目）→ 清除。
  writeCredentialFixture(storageRoot, {
    payload: Buffer.from(PLAINTEXT_VALUE, 'utf8').toString('base64'),
    scheme: 'obfuscated',
    lastReadFailureAt: firstFailureAt,
  });
  clearCacheForTest();
  const succeeded = await readCredentialValue(CREDENTIAL_REF);
  assert.equal(succeeded.ok, true);
  assert.equal(readEntry(storageRoot).lastReadFailureAt, null, '成功读取清除失败留痕');

  // 重新保存凭证（含轮换）→ 清除并落新 scheme。
  writeCredentialFixture(storageRoot, {
    payload: Buffer.from([0xc3, 0x28]).toString('base64'),
    scheme: 'obfuscated',
  });
  clearCacheForTest();
  const failedThird = await readCredentialValue(CREDENTIAL_REF);
  assert.equal(failedThird.ok, false);
  assert.equal(typeof readEntry(storageRoot).lastReadFailureAt, 'string');
  installWorkingProvider();
  const rewritten = await setCredentialForConnection(CONNECTION_ID, 'sk-rotated-value');
  assert.ok(rewritten, 'rotation should be written');
  const entryAfterRewrite = readEntry(storageRoot);
  assert.equal(entryAfterRewrite.lastReadFailureAt, null, '重新保存清除失败留痕');
  assert.equal(entryAfterRewrite.scheme, 'os_safe_storage');
  assert.equal(entryAfterRewrite.version, 2);
});

void test('acquireLease 判别式返回：版本漂移 → version_mismatch；版本一致 → 可用', async (t) => {
  withIsolatedRoot(t);
  setCredentialCryptoProvider(null);
  const written = await setCredentialForConnection(CONNECTION_ID, PLAINTEXT_VALUE);
  assert.ok(written, 'credential should be written');

  const drifted = await acquireLease({
    connectionId: CONNECTION_ID,
    credentialRef: CREDENTIAL_REF,
    credentialVersion: 99,
    connectionRevision: 0,
  });
  assert.equal(drifted.ok, false);
  if (drifted.ok) return;
  assert.equal(drifted.reason, 'version_mismatch');

  const lease = await acquireLease({
    connectionId: CONNECTION_ID,
    credentialRef: CREDENTIAL_REF,
    credentialVersion: written.version,
    connectionRevision: 0,
  });
  assert.equal(lease.ok, true);
  if (!lease.ok) return;
  assert.equal(lease.value, PLAINTEXT_VALUE);
});
