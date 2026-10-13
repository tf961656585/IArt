import { createInstance, type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import type { ModelAssetLocalizationBundle } from "@iart/contracts/model-asset-contract";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  SUPPORTED_LOCALES,
  type AppLocale,
} from "@/lib/i18n/locales";
import { i18nResources, defaultNS, namespaces } from "./resources";

let clientInstance: I18nInstance | null = null;

const createClientInstance = (): I18nInstance => {
  const instance = createInstance();
  instance
    .use(initReactI18next)
    .init({
      resources: i18nResources,
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: SUPPORTED_LOCALES,
      defaultNS,
      ns: namespaces,
      interpolation: {
        escapeValue: false,
      },
      load: "currentOnly",
      initImmediate: false,
    })
    .catch((error) => {
      console.error("[i18n] failed to initialize", error);
    });
  return instance;
};

export const getClientI18n = (): I18nInstance => {
  if (!clientInstance) {
    clientInstance = createClientInstance();
  }
  return clientInstance;
};

export const setClientLanguage = async (locale: string | undefined) => {
  const instance = getClientI18n();
  const target = normalizeLocale(locale) as AppLocale;
  if (instance.language !== target) {
    await instance.changeLanguage(target);
  }
};

export const registerModelAssetLocalizationBundles = (
  bundles: ModelAssetLocalizationBundle[] | undefined,
): void => {
  if (!Array.isArray(bundles) || bundles.length === 0) {
    return;
  }
  const instance = getClientI18n();
  bundles.forEach((bundle) => {
    const namespace = bundle.namespace.trim();
    if (!namespace) {
      return;
    }
    SUPPORTED_LOCALES.forEach((locale) => {
      const resource = bundle.resources[locale];
      if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
        return;
      }
      instance.addResourceBundle(locale, namespace, resource, true, true);
    });
  });
};
