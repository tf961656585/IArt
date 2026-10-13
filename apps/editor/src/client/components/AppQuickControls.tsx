'use client';

import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/client/store/appStore';
import { useRuntimeStore } from '@/client/store/runtimeStore';
import { LanguageSwitcher } from '@/client/components/LanguageSwitcher';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function AppQuickControls() {
  const { t } = useTranslation('layout');
  const themeMode = useAppStore((state) => state.themeMode);
  const setThemeMode = useAppStore((state) => state.setThemeMode);
  const appVersion = useRuntimeStore((state) => state.appVersion);

  const toggleTheme = () => setThemeMode(themeMode === 'light' ? 'dark' : 'light');

  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleTheme}
            aria-label={t('layout:nav.toggleThemeAria')}
          >
            {themeMode === 'light' ? <Moon className="size-4" /> : <Sun className="size-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {themeMode === 'light' ? t('layout:nav.toggleThemeDark') : t('layout:nav.toggleThemeLight')}
        </TooltipContent>
      </Tooltip>
      <LanguageSwitcher />
      <div className="text-xs opacity-60 whitespace-nowrap">{t('sidebar.version', { version: appVersion })}</div>
    </div>
  );
}

export default AppQuickControls;

