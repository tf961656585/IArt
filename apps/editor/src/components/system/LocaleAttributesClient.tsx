"use client";

import { useEffect } from "react";
import { normalizeLocale } from "@/lib/i18n/locales";

type LocaleAttributesClientProps = {
  locale: string | undefined;
};

const LocaleAttributesClient: React.FC<LocaleAttributesClientProps> = ({ locale }) => {
  useEffect(() => {
    const normalized = normalizeLocale(locale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = normalized;
      document.body.dataset['locale'] = normalized;
      // 抑制浏览器/扩展的自动翻译与注入
      document.documentElement.setAttribute("translate", "no");
      document.documentElement.classList.add("notranslate");
      document.body.classList.add("notranslate");
      // 兼容部分翻译扩展的私有约定（best-effort）
      document.documentElement.setAttribute("data-immersive-translate-dont-translate", "true");
      document.body.setAttribute("data-immersive-translate-dont-translate", "true");
    }
  }, [locale]);

  return null;
};

LocaleAttributesClient.displayName = "LocaleAttributesClient";

export default LocaleAttributesClient;
