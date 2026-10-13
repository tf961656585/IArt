export type TaskStateRendererChannel =
  | "media-assets:changed"
  | "task:state-changed"
  | "task:state-snapshot";

export const resolveTaskStateRendererChannel = (
  message: unknown,
): TaskStateRendererChannel => {
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { type: unknown | undefined }).type === "media-assets:changed"
  ) {
    return "media-assets:changed";
  }
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { type: unknown | undefined }).type === "task:state-snapshot"
  ) {
    return "task:state-snapshot";
  }
  return "task:state-changed";
};
