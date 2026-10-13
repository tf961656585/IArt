/**
 * Package Area Storage — 命令式 mutation 写入器
 *
 * 打包区是编辑域中继 chat 之后继时间线退役后的命令式 mutation 契约族。
 * 主入口 applyPackageAreaMutation 按 mutation.action 分发到各子函数，
 * 每个子函数消费 contracts 的 mutation DTO，直接 db.prepare().run() 持久化，
 * 完成后返回 canonical 排序后的最新 PackageAreaView（由 readPackageAreaByGraphId 组装）。
 *
 * 设计依据：
 * - spec「右侧工作区与打包区服务」写入契约：Renderer 只提交明确编辑意图
 * - 边界声明：写入入参用原始形状（assetId + mediaType），不含 isMissing/mediaAsset；
 *   读取 / mutation response 用 resolved PackageAreaView
 * - 打包区无独立“打包区记录行”：空打包区即零行，无 initialize / 生命周期补齐链路
 */

import { randomUUID } from 'node:crypto';
import type { PackageAreaMutation, PackageAreaView } from '@iart/contracts';
import type { SqliteDatabase } from './sqlite-loader.cjs';
import { readPackageAreaByGraphId } from './editor-storage-read-model.cjs';

type DbHandle = SqliteDatabase;

const generatePackageEntryId = (): string => `pke_${randomUUID()}`;

// ── add-entries：追加到末尾，同一画布内同一 assetId 去重 ──

function applyAddEntries(
  db: DbHandle,
  graphId: string,
  mutation: Extract<PackageAreaMutation, { action: 'add-entries' }>,
): void {
  const now = Date.now();
  db.transaction(() => {
    const maxRow = db
      .prepare('SELECT MAX("order") AS maxOrder FROM package_entries WHERE graphId = ?')
      .get(graphId) as { maxOrder: number | null } | undefined;
    let nextOrder = (maxRow !== undefined && maxRow.maxOrder !== null ? maxRow.maxOrder : -1) + 1;
    const existsStmt = db.prepare(
      'SELECT 1 FROM package_entries WHERE graphId = ? AND assetId = ? LIMIT 1',
    );
    const insert = db.prepare(
      `INSERT INTO package_entries (packageEntryId, graphId, "order", assetId, mediaType, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of mutation.entries) {
      const existing = existsStmt.get(graphId, entry.assetId) as unknown | undefined;
      if (existing !== undefined) {
        // 重复资产不静默丢弃：留 debug 痕迹（条件跳过必须留痕）。
        console.debug('[editor-storage-package-area] add-entries: asset already in package area, skip', {
          graphId,
          assetId: entry.assetId,
        });
        continue;
      }
      insert.run(generatePackageEntryId(), graphId, nextOrder, entry.assetId, entry.mediaType, now, now);
      nextOrder += 1;
    }
  })();
}

// ── remove-entries ──

function applyRemoveEntries(
  db: DbHandle,
  graphId: string,
  mutation: Extract<PackageAreaMutation, { action: 'remove-entries' }>,
): void {
  db.transaction(() => {
    const stmt = db.prepare(
      'DELETE FROM package_entries WHERE packageEntryId = ? AND graphId = ?',
    );
    for (const entryId of mutation.packageEntryIds) {
      const result = stmt.run(entryId, graphId) as { changes: number };
      if (result.changes === 0) {
        console.debug('[editor-storage-package-area] remove-entries: entry not found, no-op', {
          graphId,
          packageEntryId: entryId,
        });
      }
    }
  })();
}

// ── reorder-entries ──

function applyReorderEntries(
  db: DbHandle,
  graphId: string,
  mutation: Extract<PackageAreaMutation, { action: 'reorder-entries' }>,
): void {
  const now = Date.now();
  db.transaction(() => {
    const stmt = db.prepare(
      'UPDATE package_entries SET "order" = ?, updatedAt = ? WHERE packageEntryId = ? AND graphId = ?',
    );
    mutation.orderedEntryIds.forEach((entryId, index) => {
      stmt.run(index, now, entryId, graphId);
    });
  })();
}

// ── 主入口 ──

export function applyPackageAreaMutation(
  db: DbHandle,
  params: { graphId: string; mutation: PackageAreaMutation },
): PackageAreaView {
  const { graphId, mutation } = params;
  switch (mutation.action) {
    case 'add-entries':
      applyAddEntries(db, graphId, mutation);
      break;
    case 'remove-entries':
      applyRemoveEntries(db, graphId, mutation);
      break;
    case 'reorder-entries':
      applyReorderEntries(db, graphId, mutation);
      break;
    default: {
      const exhaustive: never = mutation;
      throw new Error(
        `[editor-storage-package-area] unhandled package area mutation action: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
  return readPackageAreaByGraphId(db, graphId);
}
