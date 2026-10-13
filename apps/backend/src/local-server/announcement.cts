import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_ANNOUNCEMENT } from './constants.cts';
import { ensureStorageDirs } from './storage.cts';

type Announcement = typeof DEFAULT_ANNOUNCEMENT;

const isAnnouncementPatch = (value: unknown): value is Partial<Announcement> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const readAnnouncement = () => {
  const { config } = ensureStorageDirs();
  const filePath = path.join(config, 'announcement.json');
  try {
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_ANNOUNCEMENT };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return isAnnouncementPatch(parsed)
      ? { ...DEFAULT_ANNOUNCEMENT, ...parsed }
      : { ...DEFAULT_ANNOUNCEMENT };
  } catch {
    return { ...DEFAULT_ANNOUNCEMENT };
  }
};

export {
  readAnnouncement,
};
