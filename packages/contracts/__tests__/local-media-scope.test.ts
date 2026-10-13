import { describe, expect, it } from 'vitest';
import {
  ProjectRefSchema,
  StableProjectIdSchema,
  GlobalScopeRefSchema,
  ScopeRefSchema,
} from '../src/local-media-scope';

const V1_REF = 'prj_0123456789abcdef0123456789abcdef';
const V2_ID = 'spid_0123456789abcdef01234567';
const GLOBAL = '__global__';

describe('ProjectRefSchema', () => {
  it('accepts valid V1 projectRef (prj_ + 32 hex)', () => {
    expect(ProjectRefSchema.parse(V1_REF)).toBe(V1_REF);
  });

  it('rejects prj_ with too few hex digits', () => {
    expect(() => ProjectRefSchema.parse('prj_short')).toThrow();
  });

  it('rejects prj_ with non-hex chars', () => {
    expect(() => ProjectRefSchema.parse('prj_' + 'x'.repeat(32))).toThrow();
  });

  it('rejects spid_ prefix', () => {
    expect(() => ProjectRefSchema.parse(V2_ID)).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => ProjectRefSchema.parse('')).toThrow();
  });
});

describe('StableProjectIdSchema', () => {
  it('accepts valid V2 stableProjectId (spid_ + 24 hex)', () => {
    expect(StableProjectIdSchema.parse(V2_ID)).toBe(V2_ID);
  });

  it('rejects spid_ with too few hex digits', () => {
    expect(() => StableProjectIdSchema.parse('spid_short')).toThrow();
  });

  it('rejects spid_ with non-hex chars', () => {
    expect(() => StableProjectIdSchema.parse('spid_' + 'x'.repeat(24))).toThrow();
  });

  it('rejects prj_ prefix', () => {
    expect(() => StableProjectIdSchema.parse(V1_REF)).toThrow();
  });
});

describe('GlobalScopeRefSchema', () => {
  it('accepts __global__', () => {
    expect(GlobalScopeRefSchema.parse(GLOBAL)).toBe(GLOBAL);
  });

  it('rejects any other value', () => {
    expect(() => GlobalScopeRefSchema.parse('global')).toThrow();
    expect(() => GlobalScopeRefSchema.parse(V1_REF)).toThrow();
    expect(() => GlobalScopeRefSchema.parse(V2_ID)).toThrow();
  });
});

describe('ScopeRefSchema (union)', () => {
  it('accepts V2 stableProjectId', () => {
    expect(ScopeRefSchema.parse(V2_ID)).toBe(V2_ID);
  });

  it('accepts V1 projectRef', () => {
    expect(ScopeRefSchema.parse(V1_REF)).toBe(V1_REF);
  });

  it('accepts __global__', () => {
    expect(ScopeRefSchema.parse(GLOBAL)).toBe(GLOBAL);
  });

  it('rejects invalid scope values', () => {
    expect(() => ScopeRefSchema.parse('random')).toThrow();
    expect(() => ScopeRefSchema.parse('')).toThrow();
    expect(() => ScopeRefSchema.parse('prj_short')).toThrow();
    expect(() => ScopeRefSchema.parse('spid_short')).toThrow();
  });
});
