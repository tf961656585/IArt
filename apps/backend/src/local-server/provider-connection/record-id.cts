import * as crypto from 'node:crypto';

/**
 * 模型记录 id 的生成（`up_dep_` 前缀）。
 *
 * 用户模型记录是模型唯一的载体（spec 03 §6.1，2026-10-19 原子换轨）。记录的 `record_id` 同时
 * 是 active route 与 ExecutionSnapshot `deployment_id` 字段指向的「接入记录 id」——两处字段名
 * 沿用 `up_dep_` 前缀是为了让既有 `active-routes.json` 在升级后零改动（升级不要求用户重新选择
 * 「当前使用」，spec 03 §11）。
 *
 * 前缀不是「部署」语义残留，而是**已分发的持久化 id 形态**：改前缀等于改写用户磁盘上的既有
 * 引用。新记录一律用本函数生成，两族记录共用同一 id 空间（谁也不能与另一族撞 id）。
 */

const RECORD_ID_PREFIX = 'up_dep_';

const generateRecordId = (): string => {
  const rand = crypto.randomBytes(4).toString('hex').toLowerCase();
  const ts = Date.now().toString(36).toLowerCase();
  return `${RECORD_ID_PREFIX}${ts}_${rand}`;
};

export { generateRecordId, RECORD_ID_PREFIX };
