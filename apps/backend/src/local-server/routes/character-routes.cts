import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';

import * as constantsModule from '../constants.cts';
import * as configStoreModule from '../config-store.cts';
import * as globalCharacterStoreModule from '../global-character-store.cts';
import * as httpUtilsModule from '../http-utils.cts';
import * as storageModule from '../storage.cts';
import { readJsonBodyOrSendError } from '../http/json-route.cts';
import type { RouteDefinition } from '../http/route-registry.cts';

type CharacterRequestBodyLike = { id: unknown | undefined; name: unknown | undefined; description: unknown | undefined };
type BusboyInfo = { filename: string | undefined; mimeType: string | undefined };
type BusboyInstance = NodeJS.WritableStream & {
  on(event: 'field', listener: (fieldname: unknown, value: unknown) => void): BusboyInstance;
  on(event: 'file', listener: (fieldname: unknown, file: NodeJS.ReadableStream, info: BusboyInfo) => void): BusboyInstance;
  on(event: 'error', listener: (error: unknown) => void): BusboyInstance;
  on(event: 'finish', listener: () => void): BusboyInstance;
};
type BusboyFactoryOptions = { headers: IncomingHttpHeaders; limits: { fileSize: number | undefined } | undefined };
type BusboyFactory = (options: BusboyFactoryOptions) => BusboyInstance;

type CharacterRouteOptions = {
  buildFileTooLargeMessage: (maxBytes: unknown) => string;
};

const cjsRequire = createRequire(__filename);
const Busboy = cjsRequire('busboy') as BusboyFactory;
const { ERROR_CODES } = constantsModule;
const { getEffectiveMaxUploadSize } = configStoreModule;
const { sendJson, sendError } = httpUtilsModule;
const { ensureStorageDirs } = storageModule;
const {
  listGlobalCharacterIndex,
  getGlobalCharacterById,
  createGlobalCharacter,
  updateGlobalCharacter,
  deleteGlobalCharacter,
} = globalCharacterStoreModule;

const isJsonObject = (value: unknown): value is object =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const getCharacterRequestBodyLike = (value: unknown): CharacterRequestBodyLike | null => isJsonObject(value) ? value as CharacterRequestBodyLike : null;
const normalizeStr = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const normalizeErrorMessage = (value: unknown) => normalizeStr(value);

const createCharacterRoutes = ({ buildFileTooLargeMessage }: CharacterRouteOptions): RouteDefinition[] => [
  {
    name: 'characters',
    match: ({ pathname }) => pathname.startsWith('/api/characters/'),
    handle: async ({ req, res, pathname, corsHeaders }) => {
      if (pathname === '/api/characters/list' && req.method === 'POST') {
        sendJson(res, 200, { success: true, characters: listGlobalCharacterIndex() }, corsHeaders);
        return;
      }
      if (pathname === '/api/characters/get' && req.method === 'POST') {
        const body = await readJsonBodyOrSendError(req, res, corsHeaders);
        if (body == null) return;
        const typedReqBody = getCharacterRequestBodyLike(body);
        const id = normalizeStr(typedReqBody !== null ? typedReqBody.id : undefined);
        if (!id) {
          sendError(res, 400, ERROR_CODES.INVALID_PROJECT, 'Invalid payload', corsHeaders);
          return;
        }
        const character = getGlobalCharacterById(id);
        if (!character) {
          sendError(res, 404, ERROR_CODES.NOT_FOUND, 'Character not found', corsHeaders);
          return;
        }
        sendJson(res, 200, { success: true, character }, corsHeaders);
        return;
      }
      if (pathname === '/api/characters/update' && req.method === 'PUT') {
        const body = await readJsonBodyOrSendError(req, res, corsHeaders);
        if (body == null) return;
        const typedBody = getCharacterRequestBodyLike(body);
        const id = normalizeStr((typedBody !== null && typedBody !== undefined ? typedBody.id : undefined));
        if (!id) {
          sendError(res, 400, ERROR_CODES.INVALID_PROJECT, 'Invalid payload', corsHeaders);
          return;
        }
        const result = updateGlobalCharacter(id, {
          name: (typedBody !== null && typedBody !== undefined ? typedBody.name : undefined),
          description: (typedBody !== null && typedBody !== undefined ? typedBody.description : undefined),
        });
        if ('error' in result) {
          sendJson(res, 400, { success: false, error: normalizeErrorMessage(result.error) || 'Update failed' }, corsHeaders);
          return;
        }
        sendJson(res, 200, { success: true }, corsHeaders);
        return;
      }
      if (pathname === '/api/characters/delete' && req.method === 'DELETE') {
        const body = await readJsonBodyOrSendError(req, res, corsHeaders);
        if (body == null) return;
        const typedDelBody = getCharacterRequestBodyLike(body);
        const id = normalizeStr(typedDelBody !== null ? typedDelBody.id : undefined);
        if (!id) {
          sendError(res, 400, ERROR_CODES.INVALID_PROJECT, 'Invalid payload', corsHeaders);
          return;
        }
        const result = deleteGlobalCharacter(id);
        if ('error' in result) {
          sendJson(res, 400, { success: false, error: normalizeErrorMessage(result.error) || 'Delete failed' }, corsHeaders);
          return;
        }
        sendJson(res, 200, { success: true }, corsHeaders);
        return;
      }
      if (pathname !== '/api/characters/create' || req.method !== 'POST') {
        sendError(res, 404, ERROR_CODES.NOT_FOUND, 'Not found', corsHeaders);
        return;
      }
      const paths = ensureStorageDirs();
      const maxUploadSize = getEffectiveMaxUploadSize();
      const busboy = Busboy({ headers: req.headers, limits: { fileSize: maxUploadSize } });
      let characterName = '';
      let characterDescription = '';
      let uploadedOriginalName: string | null = null;
      let uploadedMimeType: string | null = null;
      let tmpPath: string | null = null;
      let uploadError: string | null = null;
      let uploadErrorStatus = 400;
      let uploadErrorCode = ERROR_CODES.UPLOAD_FAILED;
      let hasFile = false;
      const cleanupTmp = () => {
        try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { void 0; }
      };
      busboy.on('field', (fieldname: unknown, value: unknown) => {
        const text = typeof value === 'string' ? value : '';
        if (fieldname === 'name') characterName = text.trim();
        if (fieldname === 'description') characterDescription = text;
      });
      busboy.on('file', (fieldname: unknown, file: NodeJS.ReadableStream, info: BusboyInfo) => {
        if (fieldname !== 'file') {
          file.resume();
          return;
        }
        hasFile = true;
        uploadedOriginalName = info.filename || null;
        uploadedMimeType = info.mimeType || null;
        tmpPath = path.join(paths.cache, `${crypto.randomUUID()}${path.extname(info.filename || '') || '.bin'}.global-character.tmp`);
        const out = fs.createWriteStream(tmpPath);
        file.on('limit', () => {
          uploadError = buildFileTooLargeMessage(maxUploadSize);
          uploadErrorStatus = 413;
          uploadErrorCode = ERROR_CODES.FILE_TOO_LARGE;
          out.destroy();
        });
        file.pipe(out);
      });
      busboy.on('error', (error: unknown) => {
        if (!uploadError) uploadError = error instanceof Error ? error.message : 'Upload failed';
      });
      busboy.on('finish', async () => {
        if (uploadError) {
          cleanupTmp();
          sendJson(res, uploadErrorStatus, { success: false, error: uploadError, message: uploadError, code: uploadErrorCode }, corsHeaders);
          return;
        }
        if (!hasFile || !tmpPath) {
          cleanupTmp();
          sendJson(res, 400, { success: false, error: 'Missing file', code: ERROR_CODES.MISSING_FILE }, corsHeaders);
          return;
        }
        const created = await createGlobalCharacter({
          name: characterName,
          description: characterDescription,
          upload: {
            tmpPath,
            ...(uploadedMimeType ? { mimeType: uploadedMimeType } : {}),
            ...(uploadedOriginalName ? { originalFilename: uploadedOriginalName } : {}),
          },
        });
        cleanupTmp();
        if ('error' in created) {
          sendJson(res, 400, {
            success: false,
            error: normalizeErrorMessage(created.error) || 'Failed to create character',
            code: ERROR_CODES.INVALID_PROJECT,
          }, corsHeaders);
          return;
        }
        sendJson(res, 200, {
          success: true,
          id: created.id,
          character: {
            id: created.character.id,
            name: created.character.name,
            description: created.character.description,
            imageUrl: created.character.imageUrl,
            createdAt: created.character.createdAt,
          },
        }, corsHeaders);
      });
      req.pipe(busboy);
    },
  },
];

export { createCharacterRoutes };
