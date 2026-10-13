import type React from "react";

import type { DynamicRecord } from "@/client/utils/typeGuards";

export const sanitizeSxToStyle = (sx: unknown): React.CSSProperties => {
  if (!sx || typeof sx !== "object") return {};
  const style: React.CSSProperties & DynamicRecord = {};
  for (const [rawKey, val] of Object.entries(sx)) {
    const key = String(rawKey);
    if (
      key.startsWith("--") ||
      (!key.includes("&") &&
        !key.includes(" ") &&
        !key.includes(",") &&
        !key.includes(">") &&
        !key.includes(":") &&
        !key.includes("."))
    ) {
      style[key] = val;
    }
  }
  return style;
};
