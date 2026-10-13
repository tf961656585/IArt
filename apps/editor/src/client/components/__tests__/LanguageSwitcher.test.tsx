import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanguageSwitcher } from '../LanguageSwitcher';

const setLanguageMock = vi.fn(async () => {});

const translations: Record<string, string> = {
  'language.switcherTooltip': '语言切换',
  'language.names.zh-CN': '简体中文',
  'language.names.en': 'English',
};

vi.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

vi.mock('@/lib/i18n/locales', () => ({
  __esModule: true,
  SUPPORTED_LOCALES: ['zh-CN', 'en'],
}));

vi.mock('@/client/store/languageStore', () => ({
  __esModule: true,
  useLanguageStore: () => ({
    language: 'zh-CN',
    setLanguage: setLanguageMock,
  }),
}));

describe('LanguageSwitcher', () => {
  beforeEach(() => {
    setLanguageMock.mockReset();
    setLanguageMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('切换语言时只更新语言存储，不再执行路由跳转', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    const trigger = screen.getByRole('button');
    await user.click(trigger);

    const englishOption = await screen.findByText('English');
    await user.click(englishOption);

    await waitFor(() => {
      expect(setLanguageMock).toHaveBeenCalledWith('en');
    });
  });
});
