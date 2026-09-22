"use client"

import { useLayoutEffect, useState, type ComponentProps, type CSSProperties, type RefObject } from "react"
import { createPortal } from "react-dom"
import { ComposerPrimitive, unstable_useTriggerPopoverScopeContext } from "@assistant-ui/react"

type Props = ComponentProps<typeof ComposerPrimitive.Unstable_TriggerPopover> & {
  anchor: RefObject<HTMLDivElement | null>
}

// The trigger primitive handles matching and keyboard navigation, but does not
// position its popup. Portal it out of the thread's scrolling/clipping surface.
export function ComposerSuggestions({ anchor, children, ...props }: Props) {
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    visibility: "hidden",
  })
  useLayoutEffect(() => {
    const element = anchor.current
    if (!element) return
    const update = () => {
      const rect = element.getBoundingClientRect()
      const viewport = window.visualViewport
      const viewTop = viewport?.offsetTop ?? 0
      const viewLeft = viewport?.offsetLeft ?? 0
      const viewHeight = viewport?.height ?? window.innerHeight
      const viewWidth = viewport?.width ?? window.innerWidth
      const banner = document.querySelector('[aria-label="Platform announcement"]')?.getBoundingClientRect()
      const topEdge = Math.max(viewTop + 12, (banner?.bottom ?? 0) + 8)
      const above = Math.max(0, rect.top - topEdge - 8)
      const below = Math.max(0, viewTop + viewHeight - rect.bottom - 20)
      const side = above >= 180 || above >= below ? "top" : "bottom"
      const width = Math.min(384, viewWidth - 24)
      const height = Math.max(0, Math.min(360, side === "top" ? above : below))
      const next: CSSProperties = {
        position: "fixed",
        width,
        left: Math.max(viewLeft + 12, Math.min(rect.left, viewLeft + viewWidth - width - 12)),
        height,
        maxHeight: height,
        visibility: "visible",
        ...(side === "top" ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
      }
      setStyle((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    window.visualViewport?.addEventListener("resize", update)
    window.visualViewport?.addEventListener("scroll", update)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
      window.visualViewport?.removeEventListener("resize", update)
      window.visualViewport?.removeEventListener("scroll", update)
    }
  }, [anchor])
  return createPortal(
    <ComposerPrimitive.Unstable_TriggerPopover
      {...props}
      className="z-50 flex flex-col overflow-hidden rounded-xl bg-popover p-2 text-popover-foreground shadow-xl"
      style={style}
    >
      <KeepSuggestionVisible />
      {children}
    </ComposerPrimitive.Unstable_TriggerPopover>,
    document.body
  )
}

function KeepSuggestionVisible() {
  const { open, highlightedItemId } = unstable_useTriggerPopoverScopeContext()
  useLayoutEffect(() => {
    if (!open || !highlightedItemId) return
    const item = document.getElementById(highlightedItemId)
    const list = item?.parentElement
    if (!item || !list) return
    const top = item.offsetTop
    const bottom = top + item.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [open, highlightedItemId])
  return null
}
