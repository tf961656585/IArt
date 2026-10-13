import { resources } from "@/client/i18n/resources";

type ResourceLocale = keyof typeof resources;

export type AppLocale = ResourceLocale;

export const SUPPORTED_LOCALES: readonly AppLocale[] = Object.keys(resources) as AppLocale[];

export const DEFAULT_LOCALE: AppLocale = "zh-CN";

export const isSupportedLocale = (value: string): value is AppLocale => {
  return SUPPORTED_LOCALES.includes(value as AppLocale);
};

export const normalizeLocale = (value: string | undefined): AppLocale => {
  if (!value) {
    return DEFAULT_LOCALE;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_LOCALE;
  }
  if (isSupportedLocale(trimmed)) {
    return trimmed;
  }
  const short = trimmed.split("-")[0];
  const match = SUPPORTED_LOCALES.find((locale) => locale.split("-")[0] === short);
  return match ?? DEFAULT_LOCALE;
};

export type LocaleRouteParams = {
  locale: string | string[] | undefined;
};

const coerceLocaleParam = (value: string | string[] | undefined): string | undefined => {
  return Array.isArray(value) ? value[0] : value;
};

export const resolveLocaleParam = async (
  params: Promise<LocaleRouteParams> | LocaleRouteParams
): Promise<AppLocale> => {
  const resolved = await params;
  return normalizeLocale(coerceLocaleParam((resolved !== null && resolved !== undefined ? resolved.locale : undefined)));
};
