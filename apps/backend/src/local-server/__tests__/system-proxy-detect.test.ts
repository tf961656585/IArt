import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectSystemProxy,
  parseGnomeProxy,
  parseScutilProxy,
  parseWindowsRegistryProxy,
  type CommandRunner,
} from '../system-proxy-detect.cts';

/**
 * system-proxy-detect.cts 纯逻辑单测（无真实子进程：命令 runner 注入固定输出）。
 * 覆盖：macOS scutil 解析（HTTP/HTTPS 单边、例外列表、PAC 降级、自动检测降级、无代理）、
 * Windows 注册表解析（全局/按协议格式、ProxyOverride、未启用）、
 * GNOME 解析（none/auto/manual）。
 */

const SCUTIL_HTTPS_ONLY = [
  '<dictionary> {',
  '  HTTPEnable : 0',
  '  HTTPSEnable : 1',
  '  HTTPSPort : 7890',
  '  HTTPSProxy : 127.0.0.1',
  '  ProxyAutoConfigEnable : 0',
  '  SOCKSEnable : 0',
  '}',
].join('\n');

const SCUTIL_FULL = [
  '<dictionary> {',
  '  ExcludeSimpleHostnames : 1',
  '  HTTPEnable : 1',
  '  HTTPPort : 8080',
  '  HTTPProxy : proxy.example.com',
  '  HTTPSEnable : 1',
  '  HTTPSPort : 8080',
  '  HTTPSProxy : proxy.example.com',
  '  ProxyAutoConfigEnable : 0',
  '  ProxiesExceptionsList : (',
  '    "localhost",',
  '    "*.example.internal",',
  '    "10.0.0.0/8"',
  '  )',
  '  SOCKSEnable : 0',
  '}',
].join('\n');

const SCUTIL_PAC = [
  '<dictionary> {',
  '  HTTPEnable : 0',
  '  ProxyAutoConfigEnable : 1',
  '  ProxyAutoConfigURLString : https://corp.example.com/proxy.pac',
  '}',
].join('\n');

const SCUTIL_NONE = ['<dictionary> {', '  HTTPEnable : 0', '}', ''].join('\n');

void test('parseScutilProxy: HTTPS-only config maps to https proxy with no http proxy', () => {
  const result = parseScutilProxy(SCUTIL_HTTPS_ONLY);
  assert.equal(result.httpProxy, '');
  assert.equal(result.httpsProxy, 'http://127.0.0.1:7890');
  assert.equal(result.unsupported, null);
  assert.deepEqual(result.noProxy, []);
});

void test('parseScutilProxy: full config parses host/port and exception list', () => {
  const result = parseScutilProxy(SCUTIL_FULL);
  assert.equal(result.httpProxy, 'http://proxy.example.com:8080');
  assert.equal(result.httpsProxy, 'http://proxy.example.com:8080');
  assert.deepEqual(result.noProxy, ['localhost', '.example.internal', '10.0.0.0/8']);
  assert.equal(result.unsupported, null);
});

void test('parseScutilProxy: PAC config flagged unsupported (fallback-to-direct signal)', () => {
  const result = parseScutilProxy(SCUTIL_PAC);
  assert.equal(result.unsupported, 'pac');
});

void test('parseScutilProxy: no proxy configured yields empty result', () => {
  const result = parseScutilProxy(SCUTIL_NONE);
  assert.equal(result.httpProxy, '');
  assert.equal(result.httpsProxy, '');
  assert.equal(result.unsupported, null);
});

const REG_GLOBAL = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '    ProxyEnable    REG_DWORD    0x1',
  '    ProxyServer    REG_SZ    127.0.0.1:7890',
  '    ProxyOverride    REG_SZ    localhost;127.*;10.*;*.example.internal',
  '',
].join('\r\n');

const REG_PER_PROTOCOL = [
  '    ProxyEnable    REG_DWORD    0x1',
  '    ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:8443',
  '',
].join('\r\n');

const REG_DISABLED = ['    ProxyEnable    REG_DWORD    0x0', ''].join('\r\n');

void test('parseWindowsRegistryProxy: global server format applies to http and https', () => {
  const result = parseWindowsRegistryProxy(REG_GLOBAL);
  assert.equal(result.httpProxy, 'http://127.0.0.1:7890');
  assert.equal(result.httpsProxy, 'http://127.0.0.1:7890');
  assert.deepEqual(result.noProxy, ['localhost', '127.*', '10.*', '.example.internal']);
});

void test('parseWindowsRegistryProxy: per-protocol format maps schemes independently', () => {
  const result = parseWindowsRegistryProxy(REG_PER_PROTOCOL);
  assert.equal(result.httpProxy, 'http://127.0.0.1:8080');
  assert.equal(result.httpsProxy, 'http://127.0.0.1:8443');
});

void test('parseWindowsRegistryProxy: ProxyEnable=0 yields empty result', () => {
  const result = parseWindowsRegistryProxy(REG_DISABLED);
  assert.equal(result.httpProxy, '');
  assert.equal(result.httpsProxy, '');
});

void test('parseGnomeProxy: auto mode flagged as pac-unsupported, manual mode parsed, none empty', () => {
  assert.equal(
    parseGnomeProxy({ mode: "'auto'", httpHost: "''", httpPort: '0', httpsHost: "''", httpsPort: '0' })
      .unsupported,
    'pac',
  );
  const manual = parseGnomeProxy({
    mode: "'manual'",
    httpHost: "'127.0.0.1'",
    httpPort: 'uint32 7890',
    httpsHost: "'127.0.0.1'",
    httpsPort: 'uint32 7890',
  });
  assert.equal(manual.httpProxy, 'http://127.0.0.1:7890');
  assert.equal(manual.httpsProxy, 'http://127.0.0.1:7890');
  const none = parseGnomeProxy({
    mode: "'none'",
    httpHost: "'127.0.0.1'",
    httpPort: 'uint32 7890',
    httpsHost: "''",
    httpsPort: '0',
  });
  assert.equal(none.httpProxy, '');
});

void test('detectSystemProxy: uses injected runner per platform and swallows command failure', async () => {
  const calls: string[] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'scutil') return SCUTIL_HTTPS_ONLY;
    return '';
  };
  const darwin = await detectSystemProxy(runner, 'darwin');
  assert.equal(darwin.httpsProxy, 'http://127.0.0.1:7890');
  assert.ok(calls[0]?.startsWith('scutil'));

  const throwing: CommandRunner = async () => {
    throw new Error('ENOENT');
  };
  const failed = await detectSystemProxy(throwing, 'win32');
  assert.equal(failed.httpProxy, '');
  assert.equal(failed.httpsProxy, '');
  assert.equal(failed.unsupported, null);
});
