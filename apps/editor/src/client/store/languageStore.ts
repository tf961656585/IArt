import { createWithEqualityFn } from 'zustand/traditional';
import { getClientI18n, setClientLanguage } from '@/lib/i18n/client';
import { DEFAULT_LOCALE, normalizeLocale, type AppLocale } from '@/lib/i18n/locales';

interface LanguageState {
  language: AppLocale;
  setLanguage: (lng: AppLocale) => Promise<void>;
}

const clientI18n = getClientI18n();
const LANGUAGE_STORAGE_KEY = 'iarts_editor_locale';

const ensureSupported = (lng: string | undefined): AppLocale => {
  if (!lng) {
    return DEFAULT_LOCALE;
  }
  return normalizeLocale(lng);
};

const readStoredLanguage = (): AppLocale | null => {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return value ? ensureSupported(value) : null;
  } catch {
    return null;
  }
};

const persistLanguage = (lng: AppLocale) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
  } catch {
    // ignore
  }
};

export const useLanguageStore = createWithEqualityFn<LanguageState>()((set) => ({
  language: readStoredLanguage() ?? ensureSupported(clientI18n.resolvedLanguage ?? clientI18n.language),
  setLanguage: async (lng) => {
    const target = ensureSupported(lng);
    await setClientLanguage(target);
    persistLanguage(target);
    set({ language: target });
  }
}));

clientI18n.on('languageChanged', (lng) => {
  const target = ensureSupported(lng);
  persistLanguage(target);
  useLanguageStore.setState({ language: target });
});
