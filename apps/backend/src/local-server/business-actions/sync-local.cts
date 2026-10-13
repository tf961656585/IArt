/**
 * 本机业务同步动作实现
 * - 角色库：读写本机全局角色库（`../global-character-store.cts`）
 * - 公告：读取本机公告缓存（`../announcement.cts`）
 * 本模块不承担任何联网取数。
 */
import * as announcementModule from "../announcement.cts";
import * as constantsModule from "../constants.cts";
import * as globalCharacterStoreModule from "../global-character-store.cts";
import { isSerializedFormDataBody } from "@iart/contracts";

import {
  asArray,
  asRecord,
  getRecord,
  normalizeString,
} from "./common.cts";

const { ERROR_CODES } = constantsModule;
const {
  listGlobalCharacterIndex,
  getGlobalCharacterById,
  createGlobalCharacter,
  updateGlobalCharacter,
  deleteGlobalCharacter,
} = globalCharacterStoreModule;
const { readAnnouncement } = announcementModule;

const pickSerializedPrimaryFile = (payload: unknown) => {
  const formData = getRecord(payload, "__formData");
  const files = asArray(formData.files);
  const namedFile = files.find(
    (file) => normalizeString(asRecord(file).name) === "file",
  );
  return asRecord(namedFile ?? files[0] ?? null);
};
const getSerializedFormFieldValue = (
  payload: unknown,
  fieldName: unknown,
) => {
  const normalizedFieldName = normalizeString(fieldName);
  if (!normalizedFieldName) return "";
  const formData = getRecord(payload, "__formData");
  const fields = Array.isArray(formData.fields) ? formData.fields : [];
  const target = asRecord(
    fields.find(
      (field) => normalizeString(asRecord(field).name) === normalizedFieldName,
    ),
  );
  return target.value === undefined || target.value === null
    ? ""
    : String(target.value);
};
const buildGlobalCharacterUploadFromSerialized = (payload: unknown) => {
  const primaryFile = pickSerializedPrimaryFile(payload);
  const dataBase64 =
    typeof primaryFile.dataBase64 === "string" ? primaryFile.dataBase64 : "";
  if (!dataBase64) return null;
  try {
    return {
      buffer: Buffer.from(dataBase64, "base64"),
      mimeType:
        normalizeString(primaryFile.contentType) || "application/octet-stream",
      originalFilename: normalizeString(primaryFile.filename) || "character",
    };
  } catch {
    return null;
  }
};
const buildCharactersAdapter = (route: string) => ({
  route,
  mode: "backend_internal_adapter",
});
const buildWorkersProxyAdapter = (route: string) => ({
  route,
  mode: "backend_internal_adapter",
});
export const executeWorkersProxyAnnouncementSync = async (
  _submit: unknown | undefined,
) => ({
  ok: true,
  result: {
    ...asRecord(readAnnouncement()),
    owner: "backend",
    adapter: buildWorkersProxyAdapter("/api/workers-proxy/announcement"),
  },
});
export const executeCharactersListSync = async (_submit: unknown | undefined) => ({
  ok: true,
  result: {
    success: true,
    characters: listGlobalCharacterIndex(),
    owner: "backend",
    adapter: buildCharactersAdapter("/api/characters/list"),
  },
});
export const executeCharactersGetSync = async (submit: unknown) => {
  const payload = asRecord(asRecord(submit).payload);
  const id = normalizeString(payload.id);
  if (!id) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_PROJECT,
      message: "Invalid payload",
    };
  }
  const character = getGlobalCharacterById(id);
  if (!character) {
    return {
      ok: false,
      code: ERROR_CODES.NOT_FOUND,
      message: "Character not found",
    };
  }
  return {
    ok: true,
    result: {
      success: true,
      character,
      owner: "backend",
      adapter: buildCharactersAdapter("/api/characters/get"),
    },
  };
};
export const executeCharactersCreateSync = async (submit: unknown) => {
  const payload = asRecord(asRecord(submit).payload);
  const serializedFormData = isSerializedFormDataBody(payload.formData)
    ? payload.formData
    : null;
  if (!serializedFormData) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_JSON,
      message: "Invalid serialized form data",
    };
  }
  const upload = buildGlobalCharacterUploadFromSerialized(serializedFormData);
  if (!upload) {
    return {
      ok: false,
      code: ERROR_CODES.MISSING_FILE,
      message: "Missing file",
    };
  }
  const created = asRecord(
    await createGlobalCharacter({
      name: getSerializedFormFieldValue(serializedFormData, "name"),
      description: getSerializedFormFieldValue(
        serializedFormData,
        "description",
      ),
      upload,
    }),
  );
  if (!Object.keys(created).length || created.error) {
    const message =
      normalizeString(created.error) || "Failed to create character";
    return { ok: false, code: ERROR_CODES.INVALID_PROJECT, message };
  }
  const createdCharacter = asRecord(created.character);
  return {
    ok: true,
    result: {
      success: true,
      id: created.id,
      character: {
        id: createdCharacter.id,
        name: createdCharacter.name,
        description: createdCharacter.description,
        imageUrl: createdCharacter.imageUrl,
        createdAt: createdCharacter.createdAt,
      },
      owner: "backend",
      adapter: buildCharactersAdapter("/api/characters/create"),
    },
  };
};
export const executeCharactersUpdateSync = async (submit: unknown) => {
  const payload = asRecord(asRecord(submit).payload);
  const id = normalizeString(payload.id);
  if (!id) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_PROJECT,
      message: "Invalid payload",
    };
  }
  const result = asRecord(
    updateGlobalCharacter(id, {
      name: payload.name,
      description: payload.description,
    }),
  );
  if (!Object.keys(result).length || result.error) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_PROJECT,
      message: normalizeString(result.error) || "Update failed",
    };
  }
  return {
    ok: true,
    result: {
      success: true,
      owner: "backend",
      adapter: buildCharactersAdapter("/api/characters/update"),
    },
  };
};
export const executeCharactersDeleteSync = async (submit: unknown) => {
  const payload = asRecord(asRecord(submit).payload);
  const id = normalizeString(payload.id);
  if (!id) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_PROJECT,
      message: "Invalid payload",
    };
  }
  const result = asRecord(deleteGlobalCharacter(id));
  if (!Object.keys(result).length || result.error) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_PROJECT,
      message: normalizeString(result.error) || "Delete failed",
    };
  }
  return {
    ok: true,
    result: {
      success: true,
      owner: "backend",
      adapter: buildCharactersAdapter("/api/characters/delete"),
    },
  };
};
