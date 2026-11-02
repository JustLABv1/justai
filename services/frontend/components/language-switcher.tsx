"use client"

import { Check, Languages } from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const languages = [
  { locale: "de", label: "Deutsch" },
  { locale: "en", label: "English" },
] as const

function LanguageOptions() {
  const { locale, setLocale } = useTranslations()
  return (
    <DropdownMenuGroup>
      {languages.map((language) => (
        <DropdownMenuItem
          key={language.locale}
          onClick={() => setLocale(language.locale)}
          lang={language.locale}
          aria-current={locale === language.locale ? "true" : undefined}
        >
          {language.label}
          {locale === language.locale && (
            <Check className="ml-auto" data-icon="inline-end" />
          )}
        </DropdownMenuItem>
      ))}
    </DropdownMenuGroup>
  )
}

export function LanguageSwitcher() {
  const { t } = useTranslations()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" aria-label={t("Choose language")} />
        }
      >
        <Languages data-icon="inline-start" />
        {t("Language")}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <LanguageOptions />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function LanguageMenu() {
  const { t } = useTranslations()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Languages data-icon="inline-start" />
        {t("Language")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <LanguageOptions />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
