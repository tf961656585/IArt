import React from 'react';
import { Languages as LanguagesIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLanguageStore } from '../store/languageStore';
import { SUPPORTED_LOCALES, type AppLocale } from '@/lib/i18n/locales';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';

const languageOrder: readonly AppLocale[] = SUPPORTED_LOCALES;

const languageTagMap: Record<AppLocale, string> = {
  'zh-CN': 'ZH',
  en: 'EN'
};

const getLanguageTag = (lng: AppLocale): string => languageTagMap[lng];

export const LanguageSwitcher: React.FC = () => {
  const { t } = useTranslation('common');
  const { language, setLanguage } = useLanguageStore();

  const handleSelect = async (lng: AppLocale) => {
    await setLanguage(lng);
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('language.switcherTooltip')}
            >
              <LanguagesIcon className="size-4" />
            </Button>
          </TooltipTrigger>
        </DropdownMenuTrigger>
        <TooltipContent>{t('language.switcherTooltip')}</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={language} onValueChange={(val) => handleSelect(val as AppLocale)}>
          {languageOrder.map((lng) => (
            <DropdownMenuRadioItem key={lng} value={lng}>
              <span className="inline-flex items-center gap-2">
                <span className="inline-flex items-center justify-center rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold w-8">
                  {getLanguageTag(lng)}
                </span>
                <span>{t(`language.names.${lng}`)}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default LanguageSwitcher;
