"use client";

import type { PropsWithChildren } from "react";
import { useMemo, useEffect } from "react";
import { I18nextProvider } from "react-i18next";
import { getClientI18n, setClientLanguage } from "@/lib/i18n/client";
import { normalizeLocale } from "@/lib/i18n/locales";

interface I18nProviderProps extends PropsWithChildren {
  locale: string | undefined;
}

const I18nProvider: React.FC<I18nProviderProps> = ({ locale, children }) => {
  const i18n = useMemo(() => getClientI18n(), []);
  const normalized = normalizeLocale(locale);

  useEffect(() => {
    void setClientLanguage(normalized);
  }, [normalized]);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
};

export default I18nProvider;
