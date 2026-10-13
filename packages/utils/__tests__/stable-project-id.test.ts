import { describe, expect, it } from 'vitest';
import stableProjectIdModule from '@iart/utils/stable-project-id';
const { generateStableProjectId, isStableProjectId, STABLE_PROJECT_ID_PREFIX } =
  stableProjectIdModule;

describe('generateStableProjectId', () => {
  it('returns string starting with spid_', () => {
    const id = generateStableProjectId();
    expect(id.startsWith('spid_')).toBe(true);
  });

  it('returns string of total length 29 (spid_ + 24 hex chars)', () => {
    const id = generateStableProjectId();
    expect(id.length).toBe(5 + 24);
    expect(id.length).toBe(29);
  });

  it('returns unique values on successive calls', () => {
    const id1 = generateStableProjectId();
    const id2 = generateStableProjectId();
    expect(id1).not.toBe(id2);
  });

  it('only contains valid hex chars after prefix', () => {
    const id = generateStableProjectId();
    const hexPart = id.slice(STABLE_PROJECT_ID_PREFIX.length);
    expect(hexPart).toMatch(/^[a-f0-9]{24}$/);
  });

  it('exposes STABLE_PROJECT_ID_PREFIX as spid_', () => {
    expect(STABLE_PROJECT_ID_PREFIX).toBe('spid_');
  });
});

describe('isStableProjectId', () => {
  it('returns true for valid generated ID', () => {
    const id = generateStableProjectId();
    expect(isStableProjectId(id)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isStableProjectId(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isStableProjectId(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isStableProjectId('')).toBe(false);
  });

  it('returns false for wrong prefix', () => {
    expect(isStableProjectId('prj_abcdef1234567890abcdef12')).toBe(false);
  });

  it('returns false for wrong length (too short)', () => {
    expect(isStableProjectId('spid_abcdef1234567890')).toBe(false);
  });

  it('returns false for wrong length (too long)', () => {
    expect(isStableProjectId('spid_abcdef1234567890abcdef1234567890')).toBe(false);
  });

  it('returns false for uppercase hex chars', () => {
    expect(isStableProjectId('spid_ABCDEF1234567890ABCDEF12')).toBe(false);
  });

  it('returns false for non-hex chars', () => {
    expect(isStableProjectId('spid_ghijklmnopqrstuvwxyz123456')).toBe(false);
  });

  it('returns false for string without prefix', () => {
    expect(isStableProjectId('abcdef1234567890abcdef1234')).toBe(false);
  });
});
