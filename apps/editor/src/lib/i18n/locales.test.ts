import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, normalizeLocale } from "./locales";

describe("normalizeLocale", () => {
  it("returns fallback when value is empty", () => {
    expect(normalizeLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(" ")).toBe(DEFAULT_LOCALE);
  });

  it("keeps supported locale", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("zh-CN")).toBe("zh-CN");
  });

  it("maps language prefix", () => {
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("ko-KR")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("ja-JP")).toBe(DEFAULT_LOCALE);
  });
});
