export type AutoResultAreaItemKind = 'img' | 'vid' | 'aud' | 'txt' | 'out';

export type AutoResultAreaItemMeta = {
  baseItemId: string;
  kind: AutoResultAreaItemKind;
  oneBasedIndex: number;
};

export type ResultAreaItemRemovalIdentity = {
  itemId: string;
  baseItemId: string;
  targetKey: string;
  baseTargetKey: string | undefined;
  outputIndex: number;
};

const AUTO_RESULT_AREA_ITEM_REGEX = /^(.*)__(img|vid|aud|txt|out)_(\d+)$/;

export const parseAutoResultAreaItemMeta = (itemId: string): AutoResultAreaItemMeta | null => {
  if (typeof itemId !== 'string') return null;
  const trimmed = itemId.trim();
  if (!trimmed) return null;
  const match = trimmed.match(AUTO_RESULT_AREA_ITEM_REGEX);
  if (match === null) return null;
  const [, baseItemId, kind, rawIndex] = match;
  if (!baseItemId || !kind || !rawIndex) return null;
  const oneBasedIndex = Number.parseInt(rawIndex, 10);
  if (!Number.isFinite(oneBasedIndex) || oneBasedIndex < 1) return null;
  return {
    baseItemId,
    kind: kind as AutoResultAreaItemKind,
    oneBasedIndex,
  };
};

export const buildResultAreaTargetKey = (resultAreaNodeId: string, itemId: string): string => {
  const safeResultArea = typeof resultAreaNodeId === 'string' ? resultAreaNodeId.trim() : '';
  const safeItem = typeof itemId === 'string' ? itemId.trim() : '';
  if (!safeResultArea || !safeItem) {
    return `result-area_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  return `result-area_${safeResultArea}_${safeItem}`;
};

export const buildMediaSlotId = (baseItemId: string, oneBasedIndex: number): string => {
  const safeBase = typeof baseItemId === 'string' ? baseItemId.trim() : '';
  const safeIndex = Number.isFinite(oneBasedIndex) ? Math.max(1, Math.floor(oneBasedIndex)) : 1;
  if (!safeBase) {
    return `gitem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  return `${safeBase}__out_${safeIndex}`;
};

export const buildResultAreaAutoPrefixes = (baseItemId: string): string[] => {
  const safeBase = typeof baseItemId === 'string' ? baseItemId.trim() : '';
  if (!safeBase) return [];
  return [
    `${safeBase}__img_`,
    `${safeBase}__vid_`,
    `${safeBase}__aud_`,
    `${safeBase}__txt_`,
    `${safeBase}__out_`,
  ];
};

export const resolveMediaSlotRemovalIdentity = (
  resultAreaNodeId: string,
  itemId: string
): ResultAreaItemRemovalIdentity => {
  const autoMeta = parseAutoResultAreaItemMeta(itemId);
  const baseItemId = autoMeta !== null ? autoMeta.baseItemId : itemId.trim();
  const baseTargetKey = autoMeta !== null ? buildResultAreaTargetKey(resultAreaNodeId, autoMeta.baseItemId) : undefined;
  return {
    itemId: itemId.trim(),
    baseItemId,
    targetKey: buildResultAreaTargetKey(resultAreaNodeId, itemId),
    baseTargetKey,
    outputIndex: autoMeta ? Math.max(0, autoMeta.oneBasedIndex - 1) : 0,
  };
};
