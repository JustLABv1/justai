import { HugeiconsIcon } from "@hugeicons/react"
import type { IconSvgElement } from "@hugeicons/react"
import {
  AlarmClockIcon,
  AiEditingIcon,
  AiImageIcon,
  AiWebBrowsingIcon,
  Brain02Icon,
  Calendar03Icon,
  CheckListIcon,
  ComputerProgramming01Icon,
  File02Icon,
  FigmaIcon,
  Globe02Icon,
  GithubIcon,
  Image02Icon,
  InformationCircleIcon,
  Link01Icon,
  Linkedin01Icon,
  Mail01Icon,
  Notion01Icon,
  Notification03Icon,
  PackageOpenIcon,
  RedditIcon,
  Search01Icon,
  SlackIcon,
  SourceCodeCircleIcon,
  SquareArrowUpRight02Icon,
  Sun03Icon,
  Table02Icon,
  Target02Icon,
  Task01Icon,
  ToolsIcon,
  TwitterIcon,
} from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"
import { resolveAPIURL } from "@/lib/api"

export interface IconProps {
  size?: number
  width?: number
  height?: number
  strokeWidth?: number
  className?: string
  color?: string
}

// Category-specific icons with colors
export interface IconConfig {
  icon: IconSvgElement
  bgColor: string
  bgColorLight?: string // Light mode background
  iconColor: string
}

/**
 * Normalize a category/integration name for icon lookup
 */
const normalizeCategoryName = (name: string): string => {
  if (!name) return "general"
  return name
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
}

// Alias mapping for backwards compatibility
const iconAliases: Record<string, string> = {
  calendar: "google_calendar",
  create_pdf: "documents",
}

// Tool category icon configs - matches gaia repo pattern
const iconConfigs: Record<string, IconConfig> = {
  // Integration icons use the same Hugeicons renderer as built-in categories.
  gmail: {
    icon: Mail01Icon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  google_calendar: {
    icon: Calendar03Icon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  github: {
    icon: GithubIcon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  linear: {
    icon: Task01Icon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  slack: {
    icon: SlackIcon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  google_docs: {
    icon: File02Icon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  googlesheets: {
    icon: Table02Icon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  search: {
    icon: Search01Icon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  web_search: {
    icon: Globe02Icon,
    bgColor:
      "bg-gradient-to-br from-sky-500/30 via-cyan-500/20 to-blue-500/30 backdrop-blur",
    bgColorLight:
      "bg-gradient-to-br from-sky-100 via-cyan-100 to-blue-100 dark:from-sky-500/30 dark:via-cyan-500/20 dark:to-blue-500/30",
    iconColor: "text-sky-700 dark:text-sky-300",
  },
  browse_url: {
    icon: AiWebBrowsingIcon,
    bgColor:
      "bg-gradient-to-br from-violet-500/30 via-indigo-500/20 to-fuchsia-500/30 backdrop-blur",
    bgColorLight:
      "bg-gradient-to-br from-violet-100 via-indigo-100 to-fuchsia-100 dark:from-violet-500/30 dark:via-indigo-500/20 dark:to-fuchsia-500/30",
    iconColor: "text-violet-700 dark:text-violet-300",
  },
  weather: {
    icon: Sun03Icon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  notion: {
    icon: Notion01Icon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  twitter: {
    icon: TwitterIcon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  linkedin: {
    icon: Linkedin01Icon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  reddit: {
    icon: RedditIcon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },
  figma: {
    icon: FigmaIcon,
    bgColor: "bg-zinc-800",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-800",
    iconColor: "text-zinc-700 dark:text-white",
  },

  // Category icons (use HugeIcons components)
  todos: {
    icon: CheckListIcon,
    bgColor: "bg-emerald-500/20 backdrop-blur",
    bgColorLight: "bg-emerald-500/20",
    iconColor: "text-emerald-600 dark:text-emerald-400",
  },
  reminders: {
    icon: AlarmClockIcon,
    bgColor: "bg-sky-500/20 backdrop-blur",
    bgColorLight: "bg-sky-500/20",
    iconColor: "text-blue-600 dark:text-blue-400",
  },
  documents: {
    icon: File02Icon,
    bgColor: "bg-orange-500/20 backdrop-blur",
    bgColorLight: "bg-orange-500/20",
    iconColor: "text-orange-600 dark:text-orange-400",
  },
  development: {
    icon: SourceCodeCircleIcon,
    bgColor: "bg-sky-500/20 backdrop-blur",
    bgColorLight: "bg-sky-500/20",
    iconColor: "text-cyan-600 dark:text-cyan-400",
  },
  memory: {
    icon: Brain02Icon,
    bgColor: "bg-indigo-500/20 backdrop-blur",
    bgColorLight: "bg-indigo-500/20",
    iconColor: "text-indigo-600 dark:text-indigo-400",
  },
  creative: {
    icon: Image02Icon,
    bgColor: "bg-pink-500/20 backdrop-blur",
    bgColorLight: "bg-pink-500/20",
    iconColor: "text-pink-600 dark:text-pink-400",
  },
  generate_image: {
    icon: AiImageIcon,
    bgColor:
      "bg-gradient-to-br from-fuchsia-500/30 via-pink-500/20 to-rose-500/30 backdrop-blur",
    bgColorLight:
      "bg-gradient-to-br from-fuchsia-100 via-pink-100 to-rose-100 dark:from-fuchsia-500/30 dark:via-pink-500/20 dark:to-rose-500/30",
    iconColor: "text-fuchsia-700 dark:text-fuchsia-300",
  },
  edit_image: {
    icon: AiEditingIcon,
    bgColor:
      "bg-gradient-to-br from-amber-500/30 via-orange-500/20 to-rose-500/30 backdrop-blur",
    bgColorLight:
      "bg-gradient-to-br from-amber-100 via-orange-100 to-rose-100 dark:from-amber-500/30 dark:via-orange-500/20 dark:to-rose-500/30",
    iconColor: "text-orange-700 dark:text-orange-300",
  },
  goal_tracking: {
    icon: Target02Icon,
    bgColor: "bg-emerald-500/20 backdrop-blur",
    bgColorLight: "bg-emerald-500/20",
    iconColor: "text-emerald-600 dark:text-emerald-400",
  },
  notifications: {
    icon: Notification03Icon,
    bgColor: "bg-yellow-500/20 backdrop-blur",
    bgColorLight: "bg-yellow-500/20",
    iconColor: "text-yellow-600 dark:text-yellow-400",
  },
  support: {
    icon: InformationCircleIcon,
    bgColor: "bg-sky-500/20 backdrop-blur",
    bgColorLight: "bg-sky-500/20",
    iconColor: "text-blue-600 dark:text-blue-400",
  },
  general: {
    icon: InformationCircleIcon,
    bgColor: "bg-gray-500/20 backdrop-blur",
    bgColorLight: "bg-gray-500/20",
    iconColor: "text-gray-600 dark:text-gray-400",
  },
  integrations: {
    icon: Link01Icon,
    bgColor: "bg-zinc-700",
    bgColorLight: "bg-zinc-200 dark:bg-zinc-700",
    iconColor: "text-zinc-700 dark:text-zinc-200",
  },

  // Agent tool call categories
  handoff: {
    icon: SquareArrowUpRight02Icon,
    bgColor: "bg-sky-500/20 backdrop-blur",
    bgColorLight: "bg-sky-500/20",
    iconColor: "text-sky-600 dark:text-sky-400",
  },
  retrieve_tools: {
    icon: PackageOpenIcon,
    bgColor: "bg-indigo-500/20 backdrop-blur",
    bgColorLight: "bg-indigo-500/20",
    iconColor: "text-indigo-600 dark:text-indigo-400",
  },
  executor: {
    icon: ComputerProgramming01Icon,
    bgColor: "bg-teal-500/20 backdrop-blur",
    bgColorLight: "bg-teal-500/20",
    iconColor: "text-teal-600 dark:text-teal-400",
  },
  unknown: {
    icon: ToolsIcon,
    bgColor: "bg-zinc-500/20 backdrop-blur",
    bgColorLight: "bg-zinc-500/20",
    iconColor: "text-zinc-600 dark:text-zinc-400",
  },
}

/**
 * Get icon for a tool category with optional MCP branding.
 * Supports built-in categories and custom integration icons via iconUrl.
 */
export const getToolCategoryIcon = (
  category: string,
  iconProps: Partial<IconProps> & { showBackground?: boolean } = {},
  iconUrl?: string | null
) => {
  const { showBackground = true, ...restProps } = iconProps

  const defaultProps = {
    size: restProps.size ?? restProps.width ?? restProps.height ?? 16,
    width: restProps.width || 20,
    height: restProps.height || 20,
    strokeWidth: restProps.strokeWidth || 2,
    className: restProps.className,
  }

  // Normalize
  const normalizedCategory = normalizeCategoryName(category)

  // Resolve aliases
  const aliasedCategory =
    iconAliases[normalizedCategory] ||
    iconAliases[category] ||
    normalizedCategory

  const finalCategory = normalizeCategoryName(aliasedCategory)

  // MCP branding is more specific than the generic integrations category or
  // any built-in category inferred from the provider-facing tool name.
  if (iconUrl) {
    const iconElement = (
      // Integration icons can come from an MCP server and therefore cannot
      // be restricted to Next's statically configured image hosts.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        alt={`${category} Icon`}
        className={`${restProps.className || ""} aspect-square object-contain`}
        height={defaultProps.height}
        src={resolveAPIURL(iconUrl)}
        width={defaultProps.width}
      />
    )
    return showBackground ? (
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-200 p-1 dark:bg-zinc-700">
        {iconElement}
      </div>
    ) : (
      iconElement
    )
  }

  let config = iconConfigs[finalCategory]

  // Fallback search
  if (!config) {
    const normalizedConfigs = Object.entries(iconConfigs)
    const matchingConfig = normalizedConfigs.find(
      ([key]) => normalizeCategoryName(key) === finalCategory
    )
    if (matchingConfig) {
      config = matchingConfig[1]
    }
  }

  if (!config) {
    return null
  }

  const iconElement = (
    <HugeiconsIcon
      icon={config.icon}
      width={defaultProps.width}
      height={defaultProps.height}
      size={defaultProps.size}
      strokeWidth={defaultProps.strokeWidth}
      className={cn("shrink-0", config.iconColor, restProps.className)}
    />
  )

  // Return with or without background based on showBackground prop.
  return showBackground ? (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg p-1",
        config.bgColorLight || config.bgColor
      )}
    >
      {iconElement}
    </div>
  ) : (
    iconElement
  )
}

// Format tool names from snake_case to Title Case
export const formatToolName = (name: string): string => {
  const builtInLabels: Record<string, string> = {
    browse_url: "Browse URL",
    create_pdf: "Create PDF",
    edit_image: "Edit image",
    generate_image: "Generate image",
    web_search: "Web search",
  }
  if (builtInLabels[name]) return builtInLabels[name]

  return name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
}
