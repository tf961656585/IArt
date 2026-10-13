/**
 * Editor Storage Schema Helpers
 *
 * 承载 schema 校验需要复用的底层 SQL 读取辅助函数。
 * 被 editor-storage-schema.cts（schema 校验）消费。
 *
 * 设计原则：
 * - 只承载无状态、无业务语义的纯 SQL 工具，避免成为新的语义承载点。
 * - 通过独立的公共模块打破消费方与 schema 之间的循环 require，
 *   保证 CJS 加载顺序下 binding 在所有消费方都可见。
 *
 * 注：quoteIdentifier 本属 schema 校验内部辅助，但因 readTableInfo 依赖它，
 * 与 readTableInfo 一并迁出以避免 schema.cts 反向依赖 helpers 之外的循环。
 */

import type { SqliteDatabase } from './sqlite-loader.cjs';
import type { TableInfoRow } from './editor-storage-schema.ddl.cjs';

/**
 * 双引号包裹标识符；内部转义嵌入式双引号。
 * 用于 PRAGMA table_info() 等动态拼接场景。
 */
export const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replace(/"/g, '""')}"`;

/**
 * 标准化 SQLite 返回的名称字段；非字符串归一化为空串。
 * 用于幂等检查（列名归一化）与 schema 校验。
 */
export const normalizeName = (name: unknown): string =>
  typeof name === 'string' ? name.trim() : '';

/**
 * 读取指定表的列信息（PRAGMA table_info）。
 * 用于幂等检查（判断列是否已存在）与 schema 校验。
 */
export const readTableInfo = (db: SqliteDatabase, tableName: string): TableInfoRow[] =>
  db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as TableInfoRow[];
