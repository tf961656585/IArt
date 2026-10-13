"use client";

import type { PropsWithChildren } from "react";
import ThemeRegistry from "@/lib/theme/ThemeRegistry";
import I18nProvider from "@/components/providers/I18nProvider";
import LocaleAttributesClient from "@/components/system/LocaleAttributesClient";
import ThemeColorMetaClient from "@/components/system/ThemeColorMetaClient";
import AppThemeProvider from "@/components/providers/AppThemeProvider";
import { useRuntimeStore } from "@/client/store/runtimeStore";
import { normalizeLocale } from "@/lib/i18n/locales";

type EditorAppProvidersProps = PropsWithChildren<{
  initialLocale: string | undefined;
}>;

const EditorAppProviders: React.FC<EditorAppProvidersProps> = ({ initialLocale, children }) => {
  const runtimeLocale = useRuntimeStore((state) => state.locale);
  const locale = normalizeLocale(runtimeLocale || initialLocale);

  return (
    <ThemeRegistry>
      <I18nProvider locale={locale}>
        <LocaleAttributesClient locale={locale} />
        <ThemeColorMetaClient />
        <AppThemeProvider mode={undefined}>
          {children}
        </AppThemeProvider>
      </I18nProvider>
    </ThemeRegistry>
  );
};

export default EditorAppProviders;
