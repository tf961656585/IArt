import type { ResourceSchema } from "@/client/i18n/resources";
import { defaultNS, namespaces, resources } from "@/client/i18n/resources";
import type { AppLocale } from "./locales";

export type SupportedLanguage = AppLocale;
export type AppNamespaces = keyof ResourceSchema;

export const i18nResources = resources as Record<SupportedLanguage, ResourceSchema>;
export { defaultNS, namespaces };
