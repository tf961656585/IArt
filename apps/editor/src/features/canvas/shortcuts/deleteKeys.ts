export const CANVAS_DELETE_KEY_CODES = ['Backspace', 'Delete'] as const;

const CANVAS_DELETE_KEY_SET: ReadonlySet<string> = new Set(CANVAS_DELETE_KEY_CODES);

export const isCanvasDeleteKey = (key: string): boolean => {
  return CANVAS_DELETE_KEY_SET.has(key);
};

export const getCanvasDeleteShortcutLabel = (isMac: boolean): string => {
  return isMac ? '⌫ / fn+⌫' : 'Delete';
};

