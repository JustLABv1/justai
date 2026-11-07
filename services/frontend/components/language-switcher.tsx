"use client"

import { Check, Languages } from "lucide-react"
import { useTranslations } from "@/components/locale-provider"
import { Button } from "@/components/panelui/button"
import { Menu } from "@/components/panelui/menu"
import {
  MenuGroup as DropdownMenuGroup,
  MenuItem as DropdownMenuItem,
  MenuSub as DropdownMenuSub,
  MenuSubContent as DropdownMenuSubContent,
  MenuSubTrigger as DropdownMenuSubTrigger,
} from "@/components/panelui/menu"

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
  const { t, locale, setLocale } = useTranslations()
  return (
    <Menu>
      <Menu.Trigger
        render={
          <Button variant="ghost" size="sm" aria-label={t("Choose language")} />
        }
      >
        <Languages data-icon="inline-start" />
        {t("Language")}
      </Menu.Trigger>
      <Menu.Content align="end">
        <Menu.Group>
          {languages.map((language) => (
            <Menu.Item
              key={language.locale}
              lang={language.locale}
              aria-current={locale === language.locale ? "true" : undefined}
              onClick={() => setLocale(language.locale)}
            >
              {language.label}
              {locale === language.locale && <Check className="ml-auto" />}
            </Menu.Item>
          ))}
        </Menu.Group>
      </Menu.Content>
    </Menu>
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
