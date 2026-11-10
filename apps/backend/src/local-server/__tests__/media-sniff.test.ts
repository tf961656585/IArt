// @spec: OF-05
//
// 产物文件载体的扩展名必须与实际媒体格式一致：上游声明的 Content-Type 与内联 data URL
// 的 mime 都可能与内容不符，唯一可信的事实是字节本身。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sniffMediaFormat, sniffMediaFormatOfFile } from '../media-sniff.cts';

const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x1a, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 ', 'latin1')]);
const wav = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WAVEfmt ', 'latin1')]);
const mp4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(4)]);
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
const mp3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(8)]);

void test('按字节识别实际媒体格式，覆盖产品会落盘的常见格式', () => {
  assert.deepEqual(sniffMediaFormat(gif), { mimeType: 'image/gif', extension: '.gif' });
  assert.deepEqual(sniffMediaFormat(png), { mimeType: 'image/png', extension: '.png' });
  assert.deepEqual(sniffMediaFormat(jpeg), { mimeType: 'image/jpeg', extension: '.jpg' });
  assert.deepEqual(sniffMediaFormat(webp), { mimeType: 'image/webp', extension: '.webp' });
  assert.deepEqual(sniffMediaFormat(wav), { mimeType: 'audio/wav', extension: '.wav' });
  assert.deepEqual(sniffMediaFormat(mp4), { mimeType: 'video/mp4', extension: '.mp4' });
  assert.deepEqual(sniffMediaFormat(webm), { mimeType: 'video/webm', extension: '.webm' });
  assert.deepEqual(sniffMediaFormat(mp3), { mimeType: 'audio/mpeg', extension: '.mp3' });
});

const svgWithDeclaration = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0"/></svg>',
  'utf8',
);
const svgBare = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');

void test('SVG 文本按 `<svg` 识别为矢量格式，普通 XML 不误判', () => {
  assert.deepEqual(sniffMediaFormat(svgWithDeclaration), { mimeType: 'image/svg+xml', extension: '.svg' });
  assert.deepEqual(sniffMediaFormat(svgBare), { mimeType: 'image/svg+xml', extension: '.svg' });
  assert.equal(sniffMediaFormat(Buffer.from('<?xml version="1.0"?><root/>', 'utf8')), null);
});

void test('GIF87a 与 GIF89a 都识别为动画 GIF', () => {
  assert.equal(sniffMediaFormat(Buffer.from('GIF87a', 'latin1'))?.extension, '.gif');
  assert.equal(sniffMediaFormat(Buffer.from('GIF89a', 'latin1'))?.extension, '.gif');
});

void test('认不出或字节不足返回 null，由调用方回落声明值', () => {
  assert.equal(sniffMediaFormat(Buffer.alloc(0)), null);
  assert.equal(sniffMediaFormat(Buffer.from([0x89, 0x50])), null);
  assert.equal(sniffMediaFormat(Buffer.from('not a media file at all', 'utf8')), null);
});

void test('文件嗅探读头部，不把整文件读进内存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-sniff-'));
  try {
    const gifPath = join(dir, 'declared-as-png.png');
    writeFileSync(gifPath, gif);
    assert.deepEqual(sniffMediaFormatOfFile(gifPath), { mimeType: 'image/gif', extension: '.gif' });
    assert.equal(sniffMediaFormatOfFile(join(dir, 'missing.png')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
