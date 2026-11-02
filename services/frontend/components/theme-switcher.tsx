"use client"

import { useTranslations } from "@/components/locale-provider"
import { useSyncExternalStore } from "react"
import { Check, Monitor, Moon, Sun } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useThemeTransition } from "@/components/theme-provider"
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
import { cn } from "@/lib/utils"

const themes = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

const emptySubscribe = () => () => {}
const getClientSnapshot = () => true
const getServerSnapshot = () => false

function ThemeSwitcher({ expanded = false }: { expanded?: boolean }) {
  const { t } = useTranslations()

  const { theme, setTheme } = useThemeTransition()
  const mounted = useSyncExternalStore(
    emptySubscribe,
    getClientSnapshot,
    getServerSnapshot
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t("Choose color theme")}
            className={cn(
              expanded
                ? "h-10 w-full justify-start gap-2.5 px-3"
                : "size-9 rounded-xl text-muted-foreground"
            )}
            title={t("Choose color theme")}
            size={expanded ? "default" : "icon"}
            variant="ghost"
          />
        }
      >
        <Sun aria-hidden="true" />
        {expanded && <span>{t("Theme")}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuGroup>
          {themes.map((item) => {
            const Icon = item.icon
            const active = mounted && theme === item.value

            return (
              <DropdownMenuItem
                key={item.value}
                onClick={() => setTheme(item.value)}
              >
                <Icon data-icon="inline-start" />
                <span>{t(item.label)}</span>
                {active && <Check className="ml-auto" data-icon="inline-end" />}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ThemeMenu() {
  const { t } = useTranslations()

  const { theme, setTheme } = useThemeTransition()
  const mounted = useSyncExternalStore(
    emptySubscribe,
    getClientSnapshot,
    getServerSnapshot
  )

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Sun data-icon="inline-start" />
        {t("Appearance")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {themes.map((item) => {
          const Icon = item.icon
          const active = mounted && theme === item.value
          return (
            <DropdownMenuItem
              key={item.value}
              onClick={() => setTheme(item.value)}
            >
              <Icon data-icon="inline-start" />
              {t(item.label)}
              {active && <Check className="ml-auto" data-icon="inline-end" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export { ThemeMenu, ThemeSwitcher }
