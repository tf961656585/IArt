import {
  OpenEditorWindowResultSchema,
  type OpenEditorWindowResult,
} from "@iart/contracts";

export const normalizeOpenEditorWindowResult = (
  result: unknown,
  projectPath: string,
): OpenEditorWindowResult => {
  if (typeof result === "boolean") {
    return result
      ? { ok: true }
      : {
          ok: false,
          code: "open-editor-window-failed",
          message: "open-editor-window returned false",
          projectPath,
        };
  }
  return OpenEditorWindowResultSchema.parse(result);
};
