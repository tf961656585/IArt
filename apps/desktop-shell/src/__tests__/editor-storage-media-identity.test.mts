// @vitest-environment node
//
// 素材身份单规则与检索底座测试（真实 dist 产物 + 内存库）：
// - assetId 内容寻址单公式（docs/architecture/contracts/storage-schema.md「资产 id 派生规则」
//   2026-10-07 收敛）：id 只由 mediaType + 内容 sha256 决定，local-media scope/地址形态不影响；
//   与 Runtime Backend 侧 deriveContentAddressedAssetId 同公式（Backend 侧公式由
//   apps/backend/src/local-server/__tests__/media-asset-id.test.ts 钉死，本文件以 spec 公式对拍）。
// - 同内容跨路径收敛：导入与生成产物同内容同 id 一行，重复登记不产生第二行。
// - 原始文件名落库（docs/runtime/本地媒体导入链路.md 2026-10-07 裁定反转）：随登记写入
//   payloadJson.original.sourceFileName；同内容后写登记不携带文件名时保留既有值。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

const workspaceRoot = process.cwd();
const requireDesktop = createRequire(import.meta.url);
const mediaModuleEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-media.cjs`;
const schemaEntry = `${workspaceRoot}/apps/desktop-shell/dist/storage/editor-storage-schema.cjs`;

type UpsertResult = { assetId: string; asset: Record<string, unknown>; created: boolean } | null;

type MediaModule = {
  buildAssetId: (mediaType: string, url: string) => string | null;
  upsertMediaAsset: (
    db: unknown,
    params: {
      mediaType: string;
      url: string;
      sourceFileName?: string;
      mimeType?: string;
      sizeBytes?: number;
      width?: number;
      height?: number;
      durationMs?: number;
      fps?: number;
      thumbnailUrl?: string;
      thumbnailStatus?: string;
    },
  ) => UpsertResult;
};

type SchemaModule = { initSchema: (db: unknown) => void };

/** spec 公式参照实现：sha256("<mediaType>:<contentHash>") 前 16 字符。 */
const expectedContentAddressedId = (mediaType: string, contentHash: string): string =>
  createHash('sha256').update(`${mediaType}:${contentHash}`).digest('hex').slice(0, 16);

const SPID = 'spid_abc123def4567890123456ab'; // spid_ + 24 hex（合法 scope 形态）
const PRJ_REF = 'prj_0123456789abcdef0123456789abcdef'; // prj_ + 32 hex

describe('素材身份单规则与文件名底座', () => {
  beforeAll(() => {
    if (!existsSync(mediaModuleEntry) || !existsSync(schemaEntry)) {
      execFileSync('pnpm', ['--filter', '@iart/desktop-shell', 'build'], { cwd: workspaceRoot, stdio: 'pipe' });
    }
  });

  it('assetId 按内容寻址单公式派生：内容指纹决定 id，scope 与地址形态（V1/V2）不影响', () => {
    const mod = requireDesktop(mediaModuleEntry) as MediaModule;
    const hash = 'a'.repeat(64);
    const idV2 = mod.buildAssetId('image', `local-media://${SPID}/${hash}.png`);
    const idV1 = mod.buildAssetId('image', `local-media://${PRJ_REF}/${hash}.png`);
    expect(idV2).toBe(expectedContentAddressedId('image', hash));
    expect(idV1).toBe(idV2);
    const idVideo = mod.buildAssetId('video', `local-media://${SPID}/${hash}.mp4`);
    expect(idVideo).toBe(expectedContentAddressedId('video', hash));
    expect(idVideo).not.toBe(idV2);
  });

  it('非 local-media url 或非内容指纹 fileKey 无法派生（buildAssetId 返回 null）', () => {
    const mod = requireDesktop(mediaModuleEntry) as MediaModule;
    expect(mod.buildAssetId('image', 'https://example.com/a.png')).toBeNull();
    expect(mod.buildAssetId('image', `local-media://${SPID}/notahashname`)).toBeNull();
    expect(mod.buildAssetId('image', '')).toBeNull();
  });

  it('同内容跨路径收敛：导入与生成登记同 id 一行；文件名在无新值的后写登记中保留', () => {
    const mod = requireDesktop(mediaModuleEntry) as MediaModule;
    const schema = requireDesktop(schemaEntry) as SchemaModule;
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);
      const hash = 'b'.repeat(64);
      const url = `local-media://${SPID}/${hash}.png`;
      const imported = mod.upsertMediaAsset(db, {
        mediaType: 'image',
        url,
        sourceFileName: '海边日落.png',
        mimeType: 'image/png',
        sizeBytes: 10,
      });
      expect(imported).not.toBeNull();
      expect(imported?.assetId).toBe(expectedContentAddressedId('image', hash));
      expect(imported?.created).toBe(true);

      // 模拟生成产物登记：同内容同 url，不携带文件名
      const regenerated = mod.upsertMediaAsset(db, {
        mediaType: 'image',
        url,
        sourceFileName: undefined,
        mimeType: 'image/png',
        sizeBytes: 10,
      });
      expect(regenerated).not.toBeNull();
      expect(regenerated?.assetId).toBe(imported?.assetId);
      expect(regenerated?.created).toBe(false);

      const count = db.prepare('SELECT COUNT(*) AS n FROM media_assets').get() as { n: number };
      expect(count.n).toBe(1);
      const row = db.prepare('SELECT payloadJson FROM media_assets WHERE assetId = ?').get(imported?.assetId) as {
        payloadJson: string;
      };
      const payload = JSON.parse(row.payloadJson) as { original: { sourceFileName: string | null } };
      expect(payload.original.sourceFileName).toBe('海边日落.png');
    } finally {
      db.close();
    }
  });

  it('文件名随最新导入登记更新：同内容不同文件名的后写导入覆盖为新文件名', () => {
    const mod = requireDesktop(mediaModuleEntry) as MediaModule;
    const schema = requireDesktop(schemaEntry) as SchemaModule;
    const db = new Database(':memory:');
    try {
      schema.initSchema(db);
      const hash = 'c'.repeat(64);
      const url = `local-media://${SPID}/${hash}.png`;
      mod.upsertMediaAsset(db, { mediaType: 'image', url, sourceFileName: '首次导入.png', mimeType: 'image/png' });
      mod.upsertMediaAsset(db, { mediaType: 'image', url, sourceFileName: '改了名.png', mimeType: 'image/png' });
      const row = db
        .prepare('SELECT payloadJson FROM media_assets')
        .get() as { payloadJson: string };
      const payload = JSON.parse(row.payloadJson) as { original: { sourceFileName: string | null } };
      expect(payload.original.sourceFileName).toBe('改了名.png');
    } finally {
      db.close();
    }
  });
});
