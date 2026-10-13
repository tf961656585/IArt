import zhCNCommon from '../locales/zh-CN/common.json';
import zhCNLayout from '../locales/zh-CN/layout.json';
import zhCNPages from '../locales/zh-CN/pages.json';
import zhCNComponents from '../locales/zh-CN/components.json';
import zhCNErrors from '../locales/zh-CN/errors.json';
import zhCNForms from '../locales/zh-CN/forms.json';
import zhCNSettings from '../locales/zh-CN/settings.json';
import zhCNAnnouncements from '../locales/zh-CN/announcements.json';

import enCommon from '../locales/en/common.json';
import enLayout from '../locales/en/layout.json';
import enPages from '../locales/en/pages.json';
import enComponents from '../locales/en/components.json';
import enErrors from '../locales/en/errors.json';
import enForms from '../locales/en/forms.json';
import enSettings from '../locales/en/settings.json';
import enAnnouncements from '../locales/en/announcements.json';

export const resources = {
  'zh-CN': {
    common: zhCNCommon,
    layout: zhCNLayout,
    pages: zhCNPages,
    components: zhCNComponents,
    errors: zhCNErrors,
    forms: zhCNForms,
    settings: zhCNSettings,
    announcements: zhCNAnnouncements
  },
  en: {
    common: enCommon,
    layout: enLayout,
    pages: enPages,
    components: enComponents,
    errors: enErrors,
    forms: enForms,
    settings: enSettings,
    announcements: enAnnouncements
  }
} as const;

export type AppNamespaces = keyof (typeof resources)['zh-CN'];
export type SupportedLanguage = keyof typeof resources;
export const defaultNS: AppNamespaces = 'common';
export const namespaces: AppNamespaces[] = ['common', 'layout', 'pages', 'components', 'errors', 'forms', 'settings', 'announcements'];

export type ResourceSchema = (typeof resources)['zh-CN'];
