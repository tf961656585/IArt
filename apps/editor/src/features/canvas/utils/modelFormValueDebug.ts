import type { UnknownRecord } from "@/client/utils/typeGuards";

type RawPromptCarrier = {
  prompt: unknown | undefined;
};

export const readModelPromptValue = (value: unknown): string | undefined => {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const promptValue = (value as RawPromptCarrier).prompt;
  return typeof promptValue === "string" ? promptValue : undefined;
};

export const collectFormValueKeys = (value: unknown): string[] => {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value as UnknownRecord).sort();
};
