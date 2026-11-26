import { HugeiconsIcon } from "@hugeicons/react"
import {
  BellIcon,
  BellRingIcon,
  Radar01Icon,
  Tag01Icon,
} from "@hugeicons/core-free-icons"
import type { ComponentProps } from "react"

type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, "icon">

function make(icon: ComponentProps<typeof HugeiconsIcon>["icon"]) {
  return function TopicGlyph(props: IconProps) {
    return (
      <HugeiconsIcon
        icon={icon}
        {...props}
        strokeWidth={Number(props.strokeWidth ?? 1.75)}
      />
    )
  }
}

/** A topic / agenda item. */
export const TopicIcon = make(Tag01Icon)
/** A topic that will notify when finished. */
export const TopicNotifyIcon = make(BellRingIcon)
/** A topic without a notification. */
export const TopicQuietIcon = make(BellIcon)
/** Subscribe to topics: JustAI watches coming agendas for keywords. */
export const TopicSubscribeIcon = make(Radar01Icon)
