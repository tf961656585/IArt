const BEIJING_TIMEZONE = 'Asia/Shanghai';

export function formatBeijingTime(
  value: string | number | Date | null | undefined,
): string {
  if (value === null || value === undefined) return '-';

  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: BEIJING_TIMEZONE,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
  } catch {
    return '-';
  }
}

/** HH:mm 时钟（北京时间），会话消息 meta 等短时间展示用 */
export function formatBeijingClock(
  value: string | number | Date | null | undefined,
): string {
  if (value === null || value === undefined) return '-';

  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: BEIJING_TIMEZONE,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return '-';
  }
}

export function formatBeijingDate(
  value: string | number | Date | null | undefined,
): string {
  if (value === null || value === undefined) return '';

  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: BEIJING_TIMEZONE,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(date)
      .replace(/\//g, '-');
  } catch {
    return '';
  }
}

export const getBeijingTodayKey = (): string => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BEIJING_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const yearPart = parts.find((p) => p.type === 'year');
  const monthPart = parts.find((p) => p.type === 'month');
  const dayPart = parts.find((p) => p.type === 'day');
  const year = (yearPart !== null && yearPart !== undefined) ? yearPart.value : '';
  const month = (monthPart !== null && monthPart !== undefined) ? monthPart.value : '';
  const day = (dayPart !== null && dayPart !== undefined) ? dayPart.value : '';
  return `${year}-${month}-${day}`;
};

export const formatBeijingCompactTimestamp = (): string => {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BEIJING_TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => {
    const part = parts.find((p) => p.type === type);
    return (part !== null && part !== undefined) ? part.value : '00';
  };
  return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;
};

/** 北京时间日期键 `YYYY-MM-DD`（跨时区无歧义，供日期分组 / 分隔比较用；非法值返回空串）。 */
export const getBeijingDateKey = (
  value: string | number | Date | null | undefined,
): string => {
  if (value === null || value === undefined) return '';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: BEIJING_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type: string): string => {
      const part = parts.find((p) => p.type === type);
      return part !== undefined ? part.value : '';
    };
    const year = get('year');
    const month = get('month');
    const day = get('day');
    return year.length > 0 && month.length > 0 && day.length > 0
      ? `${year}-${month}-${day}`
      : '';
  } catch {
    return '';
  }
};

/**
 * 会话流日期分隔文案：`9月20日 周六`；与 `now`（默认当下）不同年时带上年份
 * （`2025年12月31日 周三`），避免跨年历史出现「同一天的错觉」。非法值返回空串。
 */
export const formatBeijingDateDivider = (
  value: string | number | Date | null | undefined,
  now: number | Date = Date.now(),
): string => {
  if (value === null || value === undefined) return '';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: BEIJING_TIMEZONE,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
    }).formatToParts(date);
    const get = (type: string): string => {
      const part = parts.find((p) => p.type === type);
      return part !== undefined ? part.value : '';
    };
    const year = get('year');
    const month = get('month');
    const day = get('day');
    const weekday = get('weekday');
    if (year.length === 0 || month.length === 0 || day.length === 0) return '';
    const beijingYearOfNow = getBeijingDateKey(now).slice(0, 4);
    const prefix = year === beijingYearOfNow ? '' : `${year}年`;
    return `${prefix}${month}月${day}日 ${weekday}`;
  } catch {
    return '';
  }
};

/**
 * 紧凑日期时间（北京时间）：`MM/DD HH:mm`；与 `now`（默认当下）不同年时带年份
 * （`2025/12/31 23:59`）。节点副行等空间紧张的展示位用；非法值返回空串。
 */
export const formatBeijingShortDateTime = (
  value: string | number | Date | null | undefined,
  now: number | Date = Date.now(),
): string => {
  if (value === null || value === undefined) return '';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: BEIJING_TIMEZONE,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);
    const get = (type: string): string => {
      const part = parts.find((p) => p.type === type);
      return part !== undefined ? part.value : '';
    };
    const year = get('year');
    const month = get('month');
    const day = get('day');
    const hour = get('hour');
    const minute = get('minute');
    if (year.length === 0 || month.length === 0 || day.length === 0) return '';
    const beijingYearOfNow = getBeijingDateKey(now).slice(0, 4);
    const prefix = year === beijingYearOfNow ? '' : `${year}/`;
    return `${prefix}${month}/${day} ${hour}:${minute}`;
  } catch {
    return '';
  }
};
