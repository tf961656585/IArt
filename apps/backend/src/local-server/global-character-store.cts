/**
 * 全局角色库（本机存储，全软件共用一份）
 * - 角色清单：`<configRoot>/global-characters.json`
 * - 角色图片：`<mediaRoot>/global-characters/<id>.<ext>`
 * - 角色图片只来自本机上传（临时文件或内存 buffer 二者其一），不联网、不从外部站点导入
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ensureStorageDirs } from './storage.cts';
import { getMimeType } from './mime.cts';
import mediaConstants = require('@iart/utils/media-constants');
const GLOBAL_CHARACTER_LIBRARY_VERSION = 1;
type GlobalCharacter = {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
};
type GlobalCharacterLibrary = {
  version: number;
  updatedAt: string;
  characters: GlobalCharacter[];
};
type CharacterIndexItem = {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  createdAt: number;
};
type CharacterMutationResult = { success: true } | { error: string };
type CreateGlobalCharacterResult = { id: string; character: GlobalCharacter } | { error: string };
type CharacterUploadInput = {
  tmpPath?: string;
  buffer?: Buffer;
  mimeType?: string;
  originalFilename?: string;
};
type CharacterCreateInput = {
  id?: string;
  name?: string;
  description?: string;
  upload?: CharacterUploadInput;
};
type CharacterUpdateFields = {
  name?: unknown | undefined;
  description?: unknown | undefined;
};
type StoredCharacterFields = {
  id?: unknown | undefined;
  name?: unknown | undefined;
  description?: unknown | undefined;
  imageUrl?: unknown | undefined;
  mimeType?: unknown | undefined;
  createdAt?: unknown | undefined;
  updatedAt?: unknown | undefined;
};
type StoredLibraryFields = {
  updatedAt?: unknown | undefined;
  characters?: unknown | undefined;
};
const isObjectLike = (value: unknown): boolean =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const asStoredCharacterFields = (value: unknown): StoredCharacterFields | null =>
  isObjectLike(value) ? value as StoredCharacterFields : null;
const asStoredLibraryFields = (value: unknown): StoredLibraryFields | null =>
  isObjectLike(value) ? value as StoredLibraryFields : null;
const asCharacterUpdateFields = (value: unknown): CharacterUpdateFields | null =>
  isObjectLike(value) ? value as CharacterUpdateFields : null;
const safeTrim = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const resolveMimeTypeByFileName = (filename: string): string =>
  safeTrim((getMimeType as (name: string) => unknown)(filename));
const buildEmptyGlobalCharacterLibrary = (): GlobalCharacterLibrary => ({
  version: GLOBAL_CHARACTER_LIBRARY_VERSION,
  updatedAt: new Date().toISOString(),
  characters: [],
});
const normalizeTimestamp = (value: unknown, fallback: number): number => {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return Math.round(num);
  return fallback;
};
const normalizeCharacter = (raw: unknown): GlobalCharacter | null => {
  const record = asStoredCharacterFields(raw);
  if (!record) return null;
  const id = safeTrim(record.id);
  if (!id) return null;
  const name = safeTrim(record.name) || '未命名角色';
  const description = typeof record.description === 'string' ? record.description : '';
  const imageUrl = safeTrim(record.imageUrl);
  const mimeType = safeTrim(record.mimeType) || 'image/png';
  const now = Date.now();
  const createdAt = normalizeTimestamp(record.createdAt, now);
  const updatedAt = normalizeTimestamp(record.updatedAt, createdAt);
  return {
    id,
    name,
    description,
    imageUrl,
    mimeType,
    createdAt,
    updatedAt,
  };
};
const normalizeGlobalCharacterLibrary = (raw: unknown): GlobalCharacterLibrary | null => {
  const record = asStoredLibraryFields(raw);
  if (!record) return null;
  const characters = Array.isArray(record.characters)
    ? record.characters.map((item) => normalizeCharacter(item)).filter((item): item is GlobalCharacter => Boolean(item))
    : [];
  const updatedAt =
    typeof record.updatedAt === 'string' && record.updatedAt.trim()
      ? record.updatedAt.trim()
      : new Date().toISOString();
  return {
    version: GLOBAL_CHARACTER_LIBRARY_VERSION,
    updatedAt,
    characters,
  };
};
const getGlobalCharacterLibraryFilePath = (): string => ensureStorageDirs().globalCharacters;
const getGlobalCharacterMediaDir = (): string => ensureStorageDirs().globalCharacterMediaDir;
const readGlobalCharacterLibrary = (): GlobalCharacterLibrary => {
  const filePath = getGlobalCharacterLibraryFilePath();
  if (!filePath) return buildEmptyGlobalCharacterLibrary();
  if (!fs.existsSync(filePath)) {
    return buildEmptyGlobalCharacterLibrary();
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return normalizeGlobalCharacterLibrary(parsed) ?? buildEmptyGlobalCharacterLibrary();
  } catch {
    return buildEmptyGlobalCharacterLibrary();
  }
};
const writeGlobalCharacterLibrary = (library: GlobalCharacterLibrary): boolean => {
  const filePath = getGlobalCharacterLibraryFilePath();
  if (!filePath) return false;
  try {
    fs.writeFileSync(filePath, JSON.stringify(library, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
};
const buildCharacterIndexItem = (character: GlobalCharacter): CharacterIndexItem => ({
  id: character.id,
  name: character.name,
  description: character.description,
  imageUrl: character.imageUrl,
  createdAt: character.createdAt,
});
const listGlobalCharacterIndex = (): CharacterIndexItem[] => {
  const library = readGlobalCharacterLibrary();
  return library.characters
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(buildCharacterIndexItem);
};
const getGlobalCharacterById = (characterId: unknown): GlobalCharacter | null => {
  const id = safeTrim(characterId);
  if (!id) return null;
  const library = readGlobalCharacterLibrary();
  return library.characters.find((item) => item.id === id) ?? null;
};
const guessImageExtension = (mimeType: unknown, originalFilename: unknown): string => {
  const normalized = safeTrim(mimeType).toLowerCase();
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
  };
  if (map[normalized]) return map[normalized];
  const ext = path.extname(typeof originalFilename === 'string' ? originalFilename : '');
  if (ext && ext.length <= 10) return ext;
  return '.png';
};
const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};
const moveFile = (fromPath: string, toPath: string): boolean => {
  try {
    fs.renameSync(fromPath, toPath);
    return true;
  } catch {
    try {
      fs.copyFileSync(fromPath, toPath);
      fs.unlinkSync(fromPath);
      return true;
    } catch {
      return false;
    }
  }
};
const resolveUniqueCharacterId = (library: GlobalCharacterLibrary, preferredId = ''): string => {
  const used = new Set(library.characters.map((item) => item.id));
  let nextId = safeTrim(preferredId) || crypto.randomUUID();
  while (used.has(nextId)) {
    nextId = crypto.randomUUID();
  }
  return nextId;
};
type MaterializedCharacter = {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  mimeType: string;
};
const materializeLocalUploadCharacter = (
  input: CharacterCreateInput,
  library: GlobalCharacterLibrary,
  mediaDir: string,
): MaterializedCharacter | { error: string } => {
  const name = safeTrim(input.name);
  if (!name) return { error: '角色名称不能为空' };
  const upload = input.upload;
  const tmpPath = safeTrim(upload?.tmpPath);
  const rawBuffer = upload?.buffer;
  const usableBuffer = Buffer.isBuffer(rawBuffer) && rawBuffer.length > 0 ? rawBuffer : null;
  const hasTempFile = Boolean(tmpPath) && fs.existsSync(tmpPath);
  if (!hasTempFile && !usableBuffer) {
    return { error: 'Missing file' };
  }
  const id = resolveUniqueCharacterId(library, safeTrim(input.id));
  const ext = guessImageExtension(upload?.mimeType, upload?.originalFilename);
  const finalName = `${id}${ext}`;
  const finalPath = path.join(mediaDir, finalName);
  try {
    ensureDir(mediaDir);
    if (fs.existsSync(finalPath)) {
      fs.unlinkSync(finalPath);
    }
  } catch {
    return { error: '角色图片保存失败' };
  }
  if (usableBuffer) {
    try {
      fs.writeFileSync(finalPath, usableBuffer);
    } catch {
      return { error: '角色图片保存失败' };
    }
  } else if (!hasTempFile || !moveFile(tmpPath, finalPath)) {
    return { error: '角色图片保存失败' };
  }
  const imageUrl = mediaConstants.buildLocalMediaUrl(mediaConstants.LOCAL_MEDIA_GLOBAL_REF, 'global-characters/' + finalName);
  if (!imageUrl) return { error: '角色图片无效' };
  return {
    id,
    name,
    description: typeof input.description === 'string' ? input.description : '',
    imageUrl,
    mimeType: safeTrim(upload?.mimeType) || resolveMimeTypeByFileName(finalName) || 'image/png',
  };
};
const createGlobalCharacter = async (
  input: CharacterCreateInput,
): Promise<CreateGlobalCharacterResult> => {
  const library = readGlobalCharacterLibrary();
  const mediaDir = getGlobalCharacterMediaDir();
  if (!mediaDir) return { error: '角色媒体目录无效' };
  const materialized = materializeLocalUploadCharacter(input, library, mediaDir);
  if ('error' in materialized) {
    return materialized;
  }
  const now = Date.now();
  const record: GlobalCharacter = {
    id: materialized.id,
    name: materialized.name,
    description: materialized.description,
    imageUrl: materialized.imageUrl,
    mimeType: materialized.mimeType,
    createdAt: now,
    updatedAt: now,
  };
  library.characters.unshift(record);
  library.updatedAt = new Date().toISOString();
  if (!writeGlobalCharacterLibrary(library)) {
    return { error: '写入全局角色库失败' };
  }
  return {
    id: record.id,
    character: record,
  };
};
const updateGlobalCharacter = (characterId: unknown, updates: unknown): CharacterMutationResult => {
  const id = safeTrim(characterId);
  if (!id) return { error: '角色不存在' };
  const library = readGlobalCharacterLibrary();
  const target = library.characters.find((item) => item.id === id);
  if (!target) return { error: '角色不存在' };
  const updatesRecord = asCharacterUpdateFields(updates);
  const nextName =
    updatesRecord && Object.prototype.hasOwnProperty.call(updatesRecord, 'name')
      ? safeTrim(updatesRecord.name)
      : null;
  const nextDescription =
    updatesRecord && Object.prototype.hasOwnProperty.call(updatesRecord, 'description')
      ? typeof updatesRecord.description === 'string'
        ? updatesRecord.description
        : ''
      : null;
  if (nextName !== null) {
    if (!nextName) return { error: '角色名称不能为空' };
    target.name = nextName;
  }
  if (nextDescription !== null) {
    target.description = nextDescription;
  }
  target.updatedAt = Date.now();
  library.updatedAt = new Date().toISOString();
  if (!writeGlobalCharacterLibrary(library)) return { error: '写入全局角色库失败' };
  return { success: true };
};
const deleteGlobalCharacter = (characterId: unknown): CharacterMutationResult => {
  const id = safeTrim(characterId);
  if (!id) return { error: '角色不存在' };
  const library = readGlobalCharacterLibrary();
  const before = library.characters.length;
  library.characters = library.characters.filter((item) => item.id !== id);
  if (library.characters.length === before) {
    return { error: '角色不存在' };
  }
  library.updatedAt = new Date().toISOString();
  if (!writeGlobalCharacterLibrary(library)) return { error: '写入全局角色库失败' };
  return { success: true };
};
export {
  listGlobalCharacterIndex,
  getGlobalCharacterById,
  createGlobalCharacter,
  updateGlobalCharacter,
  deleteGlobalCharacter,
};
