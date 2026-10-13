/**
 * System Prompts Storage — 用户级 SQLite 存储
 *
 * 独立于项目级数据库（project.sqlite），存储于 userData 目录。
 * 所有项目共享，跟随用户设备，不跟随项目。
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadBetterSqlite3 } from './sqlite-loader.cjs';
import type { SqliteDatabase } from './sqlite-loader.cjs';
import type { SystemPromptItem } from '@iart/contracts';

// ── 路径管理 ──

let _dbPath: string | null = null;
let _db: SqliteDatabase | null = null;

export function setSystemPromptsDbPath(userDataPath: string): void {
  _dbPath = path.join(userDataPath, 'system-prompts.sqlite');
}

function getDbPath(): string {
  if (_dbPath) return _dbPath;
  throw new Error('SystemPrompts DB path not initialized. Call setSystemPromptsDbPath() first.');
}

function getDb(): SqliteDatabase {
  if (_db) return _db;

  const Database = loadBetterSqlite3();
  _db = new Database(getDbPath());

  _db.pragma('journal_mode = WAL', { simple: true });
  _db.pragma('foreign_keys = ON', { simple: true });

  _db.exec(`
    CREATE TABLE IF NOT EXISTS system_prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      systemPrompt TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `);

  return _db;
}

// ── CRUD ──

export function listSystemPrompts(keyword: string | undefined): SystemPromptItem[] {
  const db = getDb();

  if (keyword && keyword.trim().length > 0) {
    const like = `%${keyword.trim()}%`;
    return db.prepare(
      `SELECT id, name, description, systemPrompt, createdAt, updatedAt
       FROM system_prompts
       WHERE name LIKE ? OR description LIKE ? OR systemPrompt LIKE ?
       ORDER BY updatedAt DESC`,
    ).all(like, like, like) as SystemPromptItem[];
  }

  return db.prepare(
    `SELECT id, name, description, systemPrompt, createdAt, updatedAt
     FROM system_prompts
     ORDER BY updatedAt DESC`,
  ).all() as SystemPromptItem[];
}

export function getSystemPrompt(id: string): SystemPromptItem | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, name, description, systemPrompt, createdAt, updatedAt
     FROM system_prompts WHERE id = ?`,
  ).get(id) as SystemPromptItem | undefined;
  return row ?? null;
}

export function createSystemPrompt(params: {
  name: string;
  description: string;
  systemPrompt: string;
}): SystemPromptItem {
  const db = getDb();
  const now = Date.now();
  const item: SystemPromptItem = {
    id: randomUUID(),
    name: params.name,
    description: params.description,
    systemPrompt: params.systemPrompt,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO system_prompts (id, name, description, systemPrompt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(item.id, item.name, item.description, item.systemPrompt, item.createdAt, item.updatedAt);

  return item;
}

export function updateSystemPrompt(params: {
  id: string;
  name: string | undefined;
  description: string | undefined;
  systemPrompt: string | undefined;
}): SystemPromptItem | null {
  const db = getDb();
  const existing = getSystemPrompt(params.id);
  if (!existing) return null;

  const updated: SystemPromptItem = {
    ...existing,
    name: params.name ?? existing.name,
    description: params.description ?? existing.description,
    systemPrompt: params.systemPrompt ?? existing.systemPrompt,
    updatedAt: Date.now(),
  };

  db.prepare(
    `UPDATE system_prompts SET name = ?, description = ?, systemPrompt = ?, updatedAt = ?
     WHERE id = ?`,
  ).run(updated.name, updated.description, updated.systemPrompt, updated.updatedAt, updated.id);

  return updated;
}

export function deleteSystemPrompt(id: string): boolean {
  const db = getDb();
  const result = db.prepare(
    `DELETE FROM system_prompts WHERE id = ?`,
  ).run(id) as { changes: number };
  return result.changes > 0;
}
