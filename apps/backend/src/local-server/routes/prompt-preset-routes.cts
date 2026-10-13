import * as constantsModule from '../constants.cts';
import * as httpUtilsModule from '../http-utils.cts';
import { readJsonBodyOrSendError } from '../http/json-route.cts';
import type { RouteDefinition } from '../http/route-registry.cts';
import * as promptPresetStoreModule from '../prompt-presets-store.cts';

type PromptPresetBodyLike = {
  name: unknown | undefined;
  content: unknown | undefined;
};

const { ERROR_CODES } = constantsModule;
const { sendJson, sendError } = httpUtilsModule;
const {
  listPromptPresets,
  createPromptPreset,
  updatePromptPreset,
  deletePromptPreset,
} = promptPresetStoreModule;

const getPromptPresetBodyLike = (value: unknown): PromptPresetBodyLike | null => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as PromptPresetBodyLike)
    : null;
};

const createPromptPresetRoutes = (): RouteDefinition[] => [
  {
    name: 'prompt-presets',
    match: ({ pathname }) => pathname === '/api/prompt-presets' || pathname.startsWith('/api/prompt-presets/'),
    handle: async ({ req, res, pathname, corsHeaders }) => {
      if (pathname === '/api/prompt-presets' && req.method === 'GET') {
        sendJson(res, 200, { success: true, presets: listPromptPresets() }, {
          ...corsHeaders,
          'Cache-Control': 'no-store',
        });
        return;
      }
      if (pathname === '/api/prompt-presets' && req.method === 'POST') {
        const body = await readJsonBodyOrSendError(req, res, corsHeaders);
        if (body == null) return;
        const typedBody = getPromptPresetBodyLike(body);
        const preset = createPromptPreset({
          name: typedBody !== null ? typedBody.name : undefined,
          content: typedBody !== null ? typedBody.content : undefined,
        });
        if (preset === null) {
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, 'Invalid prompt preset payload', corsHeaders);
          return;
        }
        sendJson(res, 200, { success: true, preset, message: '已创建预设' }, {
          ...corsHeaders,
          'Cache-Control': 'no-store',
        });
        return;
      }
      const presetId = decodeURIComponent(pathname.slice('/api/prompt-presets/'.length));
      if (!presetId) {
        sendError(res, 404, ERROR_CODES.NOT_FOUND, 'Not found', corsHeaders);
        return;
      }
      if (req.method === 'PUT') {
        const body = await readJsonBodyOrSendError(req, res, corsHeaders);
        if (body == null) return;
        const typedBody = getPromptPresetBodyLike(body);
        const preset = updatePromptPreset(presetId, {
          name: typedBody !== null ? typedBody.name : undefined,
          content: typedBody !== null ? typedBody.content : undefined,
        });
        if (preset === null) {
          sendError(res, 400, ERROR_CODES.INVALID_CONFIG, 'Invalid prompt preset payload or preset not found', corsHeaders);
          return;
        }
        sendJson(res, 200, { success: true, preset, message: '已保存预设' }, {
          ...corsHeaders,
          'Cache-Control': 'no-store',
        });
        return;
      }
      if (req.method === 'DELETE') {
        const deleted = deletePromptPreset(presetId);
        if (!deleted) {
          sendError(res, 404, ERROR_CODES.NOT_FOUND, 'Prompt preset not found', corsHeaders);
          return;
        }
        sendJson(res, 200, { success: true, message: '已删除预设' }, {
          ...corsHeaders,
          'Cache-Control': 'no-store',
        });
        return;
      }
      sendError(res, 405, ERROR_CODES.METHOD_NOT_ALLOWED, 'Method not allowed', corsHeaders);
    },
  },
];

export { createPromptPresetRoutes };
