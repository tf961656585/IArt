"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchAnnouncement } from "@/client/api/announcement";
import type { AnnouncementPayload } from '@iart/contracts/announcement';
import { useTranslation } from "react-i18next";
import { sanitizeHtml } from "@/client/utils/sanitizeHtml";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getBeijingTodayKey } from "@/shared/utils/time";

const STORAGE_KEY = "iarts_announcement_dismissals";

interface DismissRecord {
  updatedAt: string;
  date: string;
}

const getTodayKey = getBeijingTodayKey;

const readStoredRecord = (updatedAt: string): DismissRecord | null => {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Record<string, DismissRecord>;
    const record = (parsed !== null && parsed !== undefined ? parsed[updatedAt] : undefined);
    if (!record) {
      return null;
    }
    if (typeof record.date !== "string" || typeof record.updatedAt !== "string") {
      return null;
    }
    return record;
  } catch {
    return null;
  }
};

const storeDismissRecord = (updatedAt: string, record: DismissRecord) => {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, DismissRecord>) : {};
    parsed[updatedAt] = record;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch (error) {
    console.warn("AnnouncementBanner: failed to persist dismissal record", error);
  }
};

const shouldShowAnnouncement = (announcement: AnnouncementPayload | null): boolean => {
  if (!announcement || !announcement.enabled) {
    return false;
  }
  const updatedAt = announcement.updatedAt;
  if (!updatedAt) {
    return true;
  }
  const record = readStoredRecord(updatedAt);
  if (!record) {
    return true;
  }
  const today = getTodayKey();
  return record.date !== today;
};

const AnnouncementBanner: React.FC = () => {
  const { t } = useTranslation("announcements");
  const [announcement, setAnnouncement] = useState<AnnouncementPayload | null>(null);
  const [visible, setVisible] = useState<boolean>(false);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const data = await fetchAnnouncement();
        if (!mounted) {
          return;
        }
        setAnnouncement(data);
        setVisible(shouldShowAnnouncement(data));
      } catch (error) {
        console.warn("AnnouncementBanner: failed to load announcement", error);
        if (mounted) {
          setAnnouncement(null);
          setVisible(false);
        }
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const handleDismissToday = useCallback(() => {
    if (!announcement) {
      setVisible(false);
      return;
    }
    const updatedAt = announcement.updatedAt || "unknown";
    storeDismissRecord(updatedAt, {
      updatedAt,
      date: getTodayKey(),
    });
    setVisible(false);
  }, [announcement]);

  const handleClose = useCallback(() => {
    setVisible(false);
  }, []);

  const severity = (announcement !== null && announcement !== undefined ? announcement.severity : undefined) ?? "info";
  const severityLabel = t(`announcements:severity.${severity}`);
  const announcementTitle = (announcement !== null && announcement !== undefined ? announcement.title : undefined) ?? "";
  const announcementMessage = (announcement !== null && announcement !== undefined ? announcement.message : undefined);
  const title = useMemo(() => {
    const trimmed = announcementTitle.trim();
    return trimmed ? trimmed : null;
  }, [announcementTitle]);
  const messageHtml = useMemo(
    () => sanitizeHtml(announcementMessage),
    [announcementMessage]
  );
  if (!announcement || !announcement.enabled) return null;

  return (
    <Dialog open={visible} onOpenChange={(open) => (!open ? handleClose() : undefined)}>
      <DialogContent form="standard" size="compact">
        <DialogHeader>
          <DialogTitle className="font-semibold">
            {title ?? severityLabel}
          </DialogTitle>
        </DialogHeader>
        <Alert className="mt-2">
          <AlertTitle>
            {severityLabel}
          </AlertTitle>
          <AlertDescription>
            {messageHtml ? (
              <div className="prose prose-sm dark:prose-invert" dangerouslySetInnerHTML={{ __html: messageHtml }} />
            ) : (
              <div className="text-sm">{severityLabel}</div>
            )}
          </AlertDescription>
        </Alert>
        <DialogFooter>
          <Button variant="outline" onClick={handleDismissToday}>{t("dismissToday")}</Button>
          <Button onClick={handleClose}>{t("close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AnnouncementBanner;
