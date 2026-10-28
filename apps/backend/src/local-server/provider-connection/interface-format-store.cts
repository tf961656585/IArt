import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY } from '@iart/contracts/model-asset-contract/protocol-constants';
import { INTERFACE_FORMATS_VERSION } from '../constants.cts';
import { USER_INTERFACE_FORMAT_ORDER_BASE } from '../interface-format/draft-synthesis.cts';
import { loadPresetFormats } from '../interface-format/registry.cts';
import {
  INTERFACE_FORMAT_ID_PATTERN,
  InterfaceFormatSchema,
  type InterfaceFormat,
  type InterfaceFormatJsonObject,
  type InterfaceFormatJsonValue,
} from '../interface-format/schema.cts';
import * as loggingModule from '../logging.cts';
import { ensureStorageDirs } from '../storage.cts';
import { isPlainObject } from '../utils.cts';

/**
 * 用户自建接口格式库（2026-10-26 批次 B5a）。
 *
 * - 文件：`config/interface-formats.json`（version 1），`{ version, updatedAt, formats: [] }`
 * - **与预设分离**：预设是随软件分发的只读 JSON（`interface-format/presets/`），用户格式只存在
 *   本库；两者在 `interface-format/registry.cts` 的 `loadAllFormats()` 里合并（id 冲突时预设优先）。
 * - 逐条 `InterfaceFormatSchema.safeParse`：坏条丢弃并 debug 留痕（禁止静默丢失）。`origin`
 *   强制 `user`、`status` 强制 `ready`：本库不承载预设（磁盘里的预设条会遮蔽内置格式），
 *   也不承载未就绪格式（用户格式没有「规则未就绪」这个中间态）。
 * - 写入侧只接受**已合成完整**的实体（草稿 → 实体的翻译在 `interface-format/draft-synthesis.cts`，
 *   唯一实现）；本 store 只负责身份（id / order）与落盘，不重新解释草稿字段。
 * - `order` 从 100 起递增（预设最大 order = 80），由本 store 分配；更新不改 order。
 * - `onInterfaceFormatsChanged` 供装配方注册投影失效回调（与配方 store 同名机制对齐）。
 */

const FILE_VERSION = INTERFACE_FORMATS_VERSION;
const FORMAT_ID_PREFIX = 'if_';

type InterfaceFormatsPathMap = { interfaceFormats: string | undefined };

export interface InterfaceFormatsFile {
  version: number;
  updatedAt: string;
  formats: InterfaceFormat[];
}

const asPathMap = (value: unknown): InterfaceFormatsPathMap | null =>
  isPlainObject(value) ? (value as InterfaceFormatsPathMap) : null;

const getFilePath = (paths: unknown): string | null => {
  const record = asPathMap(paths);
  const filePath = record !== null ? record.interfaceFormats : undefined;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
};

const buildEmptyFile = (): InterfaceFormatsFile => ({
  version: FILE_VERSION,
  updatedAt: new Date(0).toISOString(),
  formats: [],
});

const normalizeFormatId = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

type InterfaceFormatFieldLike = InterfaceFormatJsonObject & {
  field_key?: InterfaceFormatJsonValue;
};

const isFieldLike = (value: InterfaceFormatJsonValue): value is InterfaceFormatFieldLike =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 剥掉历史自建格式里残留的提示词参数行。
 *
 * 旧合成器把保留键 `__prompt` 同时写进 `parameters.schema.fields`，PromptDock 把它当普通参数
 * 渲染成第二个提示词输入。实体规范只允许它存在于 `parameters.prompt_field` 与请求规则中；
 * 读盘时剥掉残留，避免要求用户重建格式，也避免整条格式被 schema 拒绝后从目录消失。
 */
const stripReservedPromptParameter = (format: InterfaceFormat): InterfaceFormat => {
  const schema = format.parameters.schema;
  const fields = schema.fields;
  if (!Array.isArray(fields)) return format;
  const keptFields = fields.filter(
    (field) => !(isFieldLike(field) && field.field_key === MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY),
  );
  const removedFields = fields.length - keptFields.length;
  let keptRequired: InterfaceFormatJsonValue[] | null = null;
  let removedRequiredKeys = 0;
  const rawRequiredFields = schema.required_fields;
  if (Array.isArray(rawRequiredFields)) {
    keptRequired = rawRequiredFields.filter((key) => key !== MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY);
    removedRequiredKeys = rawRequiredFields.length - keptRequired.length;
  }
  const defaults = format.parameters.defaults;
  const removedDefault = Object.prototype.hasOwnProperty.call(defaults, MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY);
  if (removedFields === 0 && removedRequiredKeys === 0 && !removedDefault) return format;
  loggingModule.logDebug('[interface-format-store] strip reserved prompt key from parameters', {
    formatId: format.format_id,
    removedFields,
    removedRequiredKeys,
    removedDefault,
  });
  const nextDefaults = { ...defaults };
  delete nextDefaults[MODEL_ASSET_PROMPT_RESERVED_FIELD_KEY];
  const nextSchema: InterfaceFormatJsonObject = { ...schema, fields: keptFields };
  if (keptRequired !== null) nextSchema.required_fields = keptRequired;
  return {
    ...format,
    parameters: {
      ...format.parameters,
      schema: nextSchema,
      defaults: nextDefaults,
    },
  };
};

/**
 * 生成用户格式 id（`if_` + 时间基 36 进制 + 随机段）。
 *
 * 前缀不承载业务语义，只保证「一眼能看出是用户格式 id」且落在契约字符集
 * `^[a-z0-9][a-z0-9._-]*$` 内；同一毫秒内创建多份格式由随机段区分。
 */
const generateInterfaceFormatId = (): string => {
  const rand = crypto.randomBytes(4).toString('hex').toLowerCase();
  const ts = Date.now().toString(36).toLowerCase();
  return `${FORMAT_ID_PREFIX}${ts}_${rand}`;
};

const readFromDisk = (paths: unknown): InterfaceFormatsFile | null => {
  const filePath = getFilePath(paths);
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!isPlainObject(parsed)) return null;
    const version = Number((parsed as { version: unknown }).version);
    const rawUpdatedAt = (parsed as { updatedAt: unknown }).updatedAt;
    const updatedAt = typeof rawUpdatedAt === 'string' ? rawUpdatedAt : new Date(0).toISOString();
    if (version !== FILE_VERSION) {
      loggingModule.logDebug('[interface-format-store] normalizeFile: unsupported version', { version });
      return null;
    }
    const formats: InterfaceFormat[] = [];
    const seen = new Set<string>();
    const rawFormats = (parsed as { formats: unknown }).formats;
    if (Array.isArray(rawFormats)) {
      rawFormats.forEach((entry, index) => {
        const result = InterfaceFormatSchema.safeParse(entry);
        if (!result.success) {
          loggingModule.logDebug('[interface-format-store] drop invalid interface format record', {
            index,
            error: result.error.message,
          });
          return;
        }
        if (result.data.origin !== 'user' || result.data.status !== 'ready') {
          // 本库只承载已就绪的用户格式：预设条会把内置格式遮蔽掉，pending 条没有可执行规则。
          loggingModule.logDebug('[interface-format-store] drop record with non-user origin or non-ready status', {
            index,
            formatId: result.data.format_id,
            origin: result.data.origin,
            status: result.data.status,
          });
          return;
        }
        if (seen.has(result.data.format_id)) {
          loggingModule.logDebug('[interface-format-store] drop duplicated interface format record', {
            formatId: result.data.format_id,
          });
          return;
        }
        seen.add(result.data.format_id);
        formats.push(stripReservedPromptParameter(result.data));
      });
    }
    return { version: FILE_VERSION, updatedAt, formats };
  } catch (error) {
    loggingModule.logDebug('[interface-format-store] read file failed, treated as empty library', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const writeToDisk = (paths: unknown, file: InterfaceFormatsFile): void => {
  const filePath = getFilePath(paths);
  if (!filePath) return;
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
};

let cache: InterfaceFormatsFile | null = null;

const getFile = (): InterfaceFormatsFile => {
  if (cache) return cache;
  const paths: unknown = ensureStorageDirs();
  cache = readFromDisk(paths) ?? buildEmptyFile();
  return cache;
};

type InterfaceFormatsChangeListener = () => void;

const changeListeners = new Set<InterfaceFormatsChangeListener>();

/**
 * 格式变更监听：任一写入落盘成功后触发。本 store 不感知消费方（无业务知识、不反向依赖
 * 路由/投影）：由装配方注册回调使派生快照失效。返回退订函数；监听器抛错只留痕。
 */
const onInterfaceFormatsChanged = (listener: InterfaceFormatsChangeListener): (() => void) => {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
};

const notifyInterfaceFormatsChanged = (): void => {
  for (const listener of changeListeners) {
    try {
      listener();
    } catch (error) {
      loggingModule.logDebug('[interface-format-store] change listener failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

const commitFile = (next: InterfaceFormatsFile): InterfaceFormatsFile => {
  const updated: InterfaceFormatsFile = { ...next, updatedAt: new Date().toISOString() };
  const paths: unknown = ensureStorageDirs();
  // 先落盘后置缓存：缓存与磁盘一致，变更通知只代表「落盘成功」。
  writeToDisk(paths, updated);
  cache = updated;
  notifyInterfaceFormatsChanged();
  return updated;
};

const isPresetFormatId = (formatId: string): boolean =>
  loadPresetFormats().some((preset) => preset.format_id === formatId);

/** 用户库里的全部格式（按保存顺序）。 */
const listInterfaceFormats = (): InterfaceFormat[] => [...getFile().formats];

const getUserInterfaceFormat = (formatId: unknown): InterfaceFormat | null => {
  const id = normalizeFormatId(formatId);
  if (!id) return null;
  return getFile().formats.find((item) => item.format_id === id) ?? null;
};

/** 下一个用户格式 order（从 100 起递增；与预设的最大 order 保持不重叠）。 */
const nextUserInterfaceFormatOrder = (): number => {
  const orders = getFile().formats.map((item) => item.order);
  const maxOrder = orders.length === 0 ? USER_INTERFACE_FORMAT_ORDER_BASE - 1 : Math.max(...orders);
  return Math.max(maxOrder + 1, USER_INTERFACE_FORMAT_ORDER_BASE);
};

const forceUserShape = (format: InterfaceFormat): InterfaceFormat => ({
  ...format,
  origin: 'user',
  status: 'ready',
});

export type AddInterfaceFormatResult =
  | { ok: true; format: InterfaceFormat }
  | { ok: false; reason: 'already_exists' }
  /** id 与随软件分发的预设冲突：预设优先，用户格式不得占用同名 id。 */
  | { ok: false; reason: 'preset_conflict' }
  /** 合成出的实体没通过实体 schema（理论不可达：合成期已 parse 过同一份形状）。 */
  | { ok: false; reason: 'invalid_format' };

const addInterfaceFormat = (format: InterfaceFormat): AddInterfaceFormatResult => {
  const formatId = normalizeFormatId(format.format_id);
  if (!INTERFACE_FORMAT_ID_PATTERN.test(formatId)) {
    loggingModule.logDebug('[interface-format-store] add: invalid format id', { formatId });
    return { ok: false, reason: 'invalid_format' };
  }
  if (isPresetFormatId(formatId)) {
    loggingModule.logDebug('[interface-format-store] add: id conflicts with preset format', { formatId });
    return { ok: false, reason: 'preset_conflict' };
  }
  if (getUserInterfaceFormat(formatId) !== null) {
    loggingModule.logDebug('[interface-format-store] add: already exists', { formatId });
    return { ok: false, reason: 'already_exists' };
  }
  const parsed = InterfaceFormatSchema.safeParse(forceUserShape(format));
  if (!parsed.success) {
    loggingModule.logDebug('[interface-format-store] add: invalid interface format', {
      formatId,
      error: parsed.error.message,
    });
    return { ok: false, reason: 'invalid_format' };
  }
  const file = getFile();
  const normalized = stripReservedPromptParameter(parsed.data);
  commitFile({ ...file, formats: [...file.formats, normalized] });
  return { ok: true, format: normalized };
};

export type UpdateInterfaceFormatResult =
  | { ok: true; format: InterfaceFormat }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_format' };

/**
 * 整体替换一个用户格式的实体内容（id 与 order 不变）。
 *
 * 只改内容：`format_id` 由调用方保证与路径一致（路由负责 409），`order` 保留原值——
 * 改内容不该让格式在列表里跳动。
 */
const updateInterfaceFormat = (formatId: string, format: InterfaceFormat): UpdateInterfaceFormatResult => {
  const id = normalizeFormatId(formatId);
  if (!id) return { ok: false, reason: 'not_found' };
  const file = getFile();
  const index = file.formats.findIndex((item) => item.format_id === id);
  if (index < 0) {
    loggingModule.logDebug('[interface-format-store] update: not found', { formatId: id });
    return { ok: false, reason: 'not_found' };
  }
  const existing = file.formats[index];
  if (existing === undefined) return { ok: false, reason: 'not_found' };
  const parsed = InterfaceFormatSchema.safeParse(
    forceUserShape({ ...format, format_id: id, order: existing.order }),
  );
  if (!parsed.success) {
    loggingModule.logDebug('[interface-format-store] update: invalid interface format value', {
      formatId: id,
      error: parsed.error.message,
    });
    return { ok: false, reason: 'invalid_format' };
  }
  const normalized = stripReservedPromptParameter(parsed.data);
  const next = file.formats.map((item, i) => (i === index ? normalized : item));
  commitFile({ ...file, formats: next });
  return { ok: true, format: normalized };
};

/** 删除用户格式；返回 false 表示没有这个格式。引用它的记录由投影侧按「格式不可用」自然失效。 */
const removeInterfaceFormat = (formatId: unknown): boolean => {
  const id = normalizeFormatId(formatId);
  if (!id) return false;
  const file = getFile();
  if (!file.formats.some((item) => item.format_id === id)) {
    loggingModule.logDebug('[interface-format-store] remove: not found', { formatId: id });
    return false;
  }
  commitFile({ ...file, formats: file.formats.filter((item) => item.format_id !== id) });
  return true;
};

const clearCacheForTest = (): void => {
  cache = null;
};

export {
  listInterfaceFormats,
  getUserInterfaceFormat,
  isPresetFormatId,
  nextUserInterfaceFormatOrder,
  addInterfaceFormat,
  updateInterfaceFormat,
  removeInterfaceFormat,
  onInterfaceFormatsChanged,
  generateInterfaceFormatId,
  clearCacheForTest,
};
