import {
  EDITOR_BACKEND_ACTION_NAME,
  asRecord,
  normalizeString,
} from "./common.cts";
import {
  executeMediaImageProcessSync,
  executeMediaImageThumbnailSync,
  executeMediaThumbnailReportMissingSync,
  executeMediaLocalizeSync,
  executeMediaPersistResultSync,
  executeMediaUploadSync,
  executeMediaVideoThumbnailSync,
  executeMediaVideoSpriteSheetSync,
} from "./sync-media.cts";
import {
  executeCharactersCreateSync,
  executeCharactersDeleteSync,
  executeCharactersGetSync,
  executeCharactersListSync,
  executeCharactersUpdateSync,
  executeWorkersProxyAnnouncementSync,
} from "./sync-local.cts";

export const executeBusinessSyncAction = async (
  submit: unknown,
): Promise<unknown> => {
  const submitObject = asRecord(submit);
  const actionName = normalizeString(submitObject.actionName);
  if (actionName === EDITOR_BACKEND_ACTION_NAME.WORKERS_PROXY_ANNOUNCEMENT) {
    return executeWorkersProxyAnnouncementSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.CHARACTERS_LIST) {
    return executeCharactersListSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.CHARACTERS_GET) {
    return executeCharactersGetSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.CHARACTERS_CREATE) {
    return executeCharactersCreateSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.CHARACTERS_UPDATE) {
    return executeCharactersUpdateSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.CHARACTERS_DELETE) {
    return executeCharactersDeleteSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.MEDIA_UPLOAD) {
    return executeMediaUploadSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.MEDIA_LOCALIZE) {
    return executeMediaLocalizeSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.MEDIA_PERSIST_RESULT) {
    return executeMediaPersistResultSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.MEDIA_IMAGE_THUMBNAIL) {
    return executeMediaImageThumbnailSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.MEDIA_VIDEO_THUMBNAIL) {
    return executeMediaVideoThumbnailSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.MEDIA_THUMBNAIL_REPORT_MISSING) {
    return executeMediaThumbnailReportMissingSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.MEDIA_IMAGE_PROCESS) {
    return executeMediaImageProcessSync(submit);
  }
  if (actionName === EDITOR_BACKEND_ACTION_NAME.MEDIA_VIDEO_SPRITESHEET) {
    return executeMediaVideoSpriteSheetSync(submit);
  }
  return {
    ok: false,
    code: "unsupported_action",
    message: `Unsupported business sync action: ${actionName || "(empty)"}`,
  };
};
