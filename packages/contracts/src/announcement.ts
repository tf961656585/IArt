export type AnnouncementSeverity = "info" | "success" | "warning" | "error";

export interface AnnouncementPayload {
  enabled: boolean;
  title: string;
  /**
   * 公告正文，支持HTML字符串。
   * 该字段会在前端渲染前经过DOMPurify清洗。
   */
  message: string;
  severity: AnnouncementSeverity;
  updatedAt: string;
  updatedBy: string | undefined;
}

export const announcementSeverities: AnnouncementSeverity[] = ["info", "success", "warning", "error"];

export const defaultAnnouncement: AnnouncementPayload = {
  enabled: false,
  title: "",
  message: "",
  severity: "info",
  updatedAt: new Date(0).toISOString(),
  updatedBy: "",
};

export const isAnnouncementSeverity = (value: unknown): value is AnnouncementSeverity => {
  return typeof value === "string" && announcementSeverities.includes(value as AnnouncementSeverity);
};
