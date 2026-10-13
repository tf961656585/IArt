import { describe, expect, it } from 'vitest';
import {
  CANVAS_DELETE_KEY_CODES,
  getCanvasDeleteShortcutLabel,
  isCanvasDeleteKey,
} from './deleteKeys';

describe('canvas delete key shortcuts', () => {
  // @spec: CM-012
  it('includes Backspace and Delete in delete key codes', () => {
    expect(CANVAS_DELETE_KEY_CODES).toEqual(['Backspace', 'Delete']);
  });

  it('identifies Backspace/Delete as delete keys', () => {
    expect(isCanvasDeleteKey('Backspace')).toBe(true);
    expect(isCanvasDeleteKey('Delete')).toBe(true);
  });

  it('does not treat non-delete keys as delete keys', () => {
    expect(isCanvasDeleteKey('Enter')).toBe(false);
    expect(isCanvasDeleteKey('KeyK')).toBe(false);
    expect(isCanvasDeleteKey('')).toBe(false);
  });

  it('returns platform-aware shortcut labels', () => {
    expect(getCanvasDeleteShortcutLabel(true)).toBe('⌫ / fn+⌫');
    expect(getCanvasDeleteShortcutLabel(false)).toBe('Delete');
  });
});

