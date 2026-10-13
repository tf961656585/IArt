import { describe, expect, it } from "vitest";

import { computeAutoSizeIntent, type AutoSizeGuard } from "./autoSizeIntent";

describe("computeAutoSizeIntent", () => {
  it("returns null intent when within epsilon", () => {
    const { intent, blocked } = computeAutoSizeIntent({
      currentSize: { width: 100, height: 200 },
      desiredSize: { width: 101, height: 199 },
      nowMs: 0,
      guard: null,
      epsilonPx: 1,
      guardWindowMs: undefined,
      maxUpdatesPerWindow: undefined,
    });
    expect(intent).toBeNull();
    expect(blocked).toBe(false);
  });

  it("returns intent and increments guard", () => {
    const first = computeAutoSizeIntent({
      currentSize: { width: 100, height: 100 },
      desiredSize: { width: 120, height: 80 },
      nowMs: 100,
      guard: null,
      epsilonPx: 1,
      guardWindowMs: 1500,
      maxUpdatesPerWindow: 8,
    });
    expect(first.intent).toEqual({ width: 120, height: 80 });
    expect(first.blocked).toBe(false);
    expect(first.nextGuard?.count).toBe(1);
    expect(first.nextGuard?.windowStart).toBe(100);
  });

  it("blocks after maxUpdatesPerWindow", () => {
    let guard: AutoSizeGuard = null;
    for (let i = 0; i < 3; i++) {
      const out = computeAutoSizeIntent({
        currentSize: { width: 100, height: 100 },
        desiredSize: { width: 100 + i + 10, height: 100 },
        nowMs: 0,
        guard,
        epsilonPx: 0,
        guardWindowMs: 1500,
        maxUpdatesPerWindow: 2,
      });
      guard = out.nextGuard;
      if (i < 2) {
        expect(out.blocked).toBe(false);
        expect(out.intent).not.toBeNull();
      } else {
        expect(out.blocked).toBe(true);
        expect(out.intent).toBeNull();
      }
    }
  });

  it("resets guard after window elapses", () => {
    const a = computeAutoSizeIntent({
      currentSize: { width: 100, height: 100 },
      desiredSize: { width: 120, height: 100 },
      nowMs: 0,
      guard: null,
      epsilonPx: 0,
      guardWindowMs: 10,
      maxUpdatesPerWindow: 2,
    });
    const b = computeAutoSizeIntent({
      currentSize: { width: 100, height: 100 },
      desiredSize: { width: 130, height: 100 },
      nowMs: 5,
      guard: a.nextGuard,
      epsilonPx: 0,
      guardWindowMs: 10,
      maxUpdatesPerWindow: 2,
    });
    const c = computeAutoSizeIntent({
      currentSize: { width: 100, height: 100 },
      desiredSize: { width: 140, height: 100 },
      nowMs: 11,
      guard: b.nextGuard,
      epsilonPx: 0,
      guardWindowMs: 10,
      maxUpdatesPerWindow: 2,
    });

    expect(b.nextGuard?.count).toBe(2);
    expect(c.nextGuard?.count).toBe(1);
    expect(c.nextGuard?.windowStart).toBe(11);
  });
});
