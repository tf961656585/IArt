import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { deriveContentAddressedAssetId } from '../media-asset-id.cts';

/**
 * 内容寻址资产 id 派生单元测试。
 *
 * 公式唯一文档事实源：docs/architecture/contracts/storage-schema.md
 * runtime_domain.media_assets「资产 id 派生规则」（2026-10-07 登记）——
 * sha256("<mediaType>:<contentHash>") 前 16 字符、小写十六进制。
 * 本测试把公式钉死，防止收敛后的共享 helper 与文档漂移。
 */
void test('deriveContentAddressedAssetId：sha256(mediaType:contentHash) 前 16 位小写 hex', () => {
  const contentHash = crypto.createHash('sha256').update('demo-bytes').digest('hex');
  const expected = crypto
    .createHash('sha256')
    .update(`image:${contentHash}`)
    .digest('hex')
    .slice(0, 16);
  const actual = deriveContentAddressedAssetId('image', contentHash);
  assert.equal(actual, expected);
  assert.match(actual, /^[0-9a-f]{16}$/);
});

void test('deriveContentAddressedAssetId：mediaType 参与摘要（不同媒体类型不同 id）', () => {
  const contentHash = crypto.createHash('sha256').update('same-bytes').digest('hex');
  const imageId = deriveContentAddressedAssetId('image', contentHash);
  const videoId = deriveContentAddressedAssetId('video', contentHash);
  assert.notEqual(imageId, videoId);
  assert.match(videoId, /^[0-9a-f]{16}$/);
});

void test('deriveContentAddressedAssetId：同输入确定性（幂等）', () => {
  const contentHash = crypto.createHash('sha256').update('stable-bytes').digest('hex');
  assert.equal(
    deriveContentAddressedAssetId('image', contentHash),
    deriveContentAddressedAssetId('image', contentHash),
  );
});
