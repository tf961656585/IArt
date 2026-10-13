import { isUnknownRecord } from "@/client/utils/typeGuards";
import type { SchemaTimelineSegment } from "./types";

interface ShotListItemRaw {
  index: unknown | undefined;
  startAtSeconds: unknown | undefined;
  startAt: unknown | undefined;
  start: unknown | undefined;
  endAtSeconds: unknown | undefined;
  endAt: unknown | undefined;
  end: unknown | undefined;
  durationSeconds: unknown | undefined;
  duration: unknown | undefined;
  seconds: unknown | undefined;
  length: unknown | undefined;
  beats: unknown | undefined;
  storyBeats: unknown | undefined;
  timeline: unknown | undefined;
  notes: unknown | undefined;
  tags: unknown | undefined;
  id: unknown | undefined;
  key: unknown | undefined;
  slug: unknown | undefined;
  title: unknown | undefined;
  name: unknown | undefined;
  label: unknown | undefined;
  summary: unknown | undefined;
  logline: unknown | undefined;
  description: unknown | undefined;
  prompt: unknown | undefined;
  text: unknown | undefined;
  cameraMotion: unknown | undefined;
  camera: unknown | undefined;
  motion: unknown | undefined;
  audioCue: unknown | undefined;
  audio: unknown | undefined;
  soundtrack: unknown | undefined;
  referenceUrl: unknown | undefined;
  reference: unknown | undefined;
  referenceImage: unknown | undefined;
  assetUrl: unknown | undefined;
  transition: unknown | undefined;
  metadata: unknown | undefined;
}

const isShotListItemRaw = (value: unknown): value is ShotListItemRaw => {
  return isUnknownRecord(value);
};

const toTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toNumberValue = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const toStringArrayValue = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((item) => toTrimmedString(item))
      .filter((item): item is string => Boolean(item));
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  return [];
};

export const normalizeShotListValue = (value: unknown): SchemaTimelineSegment[] => {
  if (!Array.isArray(value)) return [];
  let cursor = 0;
  return value.reduce<SchemaTimelineSegment[]>((segments, item, index) => {
    if (!isShotListItemRaw(item)) return segments;
    const record = item;
    const providedIndex = toNumberValue(record.index);
    const start = toNumberValue(record.startAtSeconds ?? record.startAt ?? record.start);
    const end = toNumberValue(record.endAtSeconds ?? record.endAt ?? record.end);
    let duration = toNumberValue(record.durationSeconds ?? record.duration ?? record.seconds ?? record.length);
    const startAt = start ?? cursor;
    let endAt = end;
    if (typeof duration === "number" && duration < 0) duration = Math.abs(duration);
    if (duration === undefined && endAt !== undefined) duration = Math.max(0, endAt - startAt);
    if (duration !== undefined && endAt === undefined) endAt = startAt + duration;
    if (duration !== undefined && duration === 0) duration = undefined;
    if (endAt !== undefined && duration === undefined && start !== undefined) duration = Math.max(0, endAt - startAt);
    if (endAt !== undefined) cursor = endAt;
    else if (duration !== undefined) cursor = startAt + duration;

    const beats = toStringArrayValue(record.beats ?? record.storyBeats ?? record.timeline ?? record.notes);
    const tags = toStringArrayValue(record.tags);
    const id = toTrimmedString(record.id ?? record.key ?? record.slug);
    const title = toTrimmedString(record.title ?? record.name ?? record.label);
    const summary = toTrimmedString(record.summary ?? record.logline);
    const explicitDescription = toTrimmedString(record.description ?? record.prompt ?? record.text);
    const cameraMotion = toTrimmedString(record.cameraMotion ?? record.camera ?? record.motion);
    const audioCue = toTrimmedString(record.audioCue ?? record.audio ?? record.soundtrack);
    const referenceUrl = toTrimmedString(record.referenceUrl ?? record.reference ?? record.referenceImage ?? record.assetUrl);
    const transition = toTrimmedString(record.transition);
    const fallbackDescription = summary ?? (beats.length > 0 ? beats.join("; ") : undefined);
    const description = explicitDescription ?? fallbackDescription;
    const segment: SchemaTimelineSegment = {
      id,
      index: providedIndex ?? index,
      title,
      summary,
      description,
      beats: beats.length > 0 ? beats : undefined,
      durationSeconds: typeof duration === "number" ? duration : undefined,
      cameraMotion,
      audioCue,
      referenceUrl,
      tags: tags.length > 0 ? tags : undefined,
      transition,
      startAtSeconds: startAt,
      endAtSeconds: typeof endAt === "number" ? endAt : undefined,
      metadata: isUnknownRecord(record.metadata) ? record.metadata : undefined,
    };
    segments.push(segment);
    return segments;
  }, []);
};

export const timelineToNarrative = (value: unknown): string | undefined => {
  const lines = normalizeShotListValue(value)
    .map((segment) => {
      const segmentBeats = segment.beats;
      const parts = [`${segment.index + 1}.`];
      if (typeof segment.durationSeconds === "number" && segment.durationSeconds > 0) {
        parts.push(`[${Math.round(segment.durationSeconds)}s]`);
      }
      if (segment.title) parts.push(segment.title);
      const descriptors = [
        segment.description,
        segment.cameraMotion ? `Camera: ${segment.cameraMotion}` : undefined,
        segmentBeats !== undefined && segmentBeats.length > 0 ? `Beats: ${segmentBeats.join(" / ")}` : undefined,
        segment.audioCue ? `Audio: ${segment.audioCue}` : undefined,
        segment.transition ? `Transition: ${segment.transition}` : undefined,
      ].filter((item): item is string => Boolean(item));
      if (descriptors.length) parts.push("—", descriptors.join(" | "));
      return parts.join(" ").replace(/\s+/g, " ").trim();
    })
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join("\n") : undefined;
};
