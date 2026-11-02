"use client"

import { useLayoutEffect, useRef } from "react"
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-9 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

/** Scroll just the tab strip, preserving the page's vertical scroll position. */
function ScrollableTabsList(props: React.ComponentProps<typeof TabsList>) {
  const viewportRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    let frame = 0
    const revealActiveTab = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const active = viewport.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]'
        )
        if (!active) return
        const bounds = viewport.getBoundingClientRect()
        const tab = active.getBoundingClientRect()
        const padding = 8
        const offset =
          tab.left < bounds.left + padding
            ? tab.left - bounds.left - padding
            : tab.right > bounds.right - padding
              ? tab.right - bounds.right + padding
              : 0
        if (offset) viewport.scrollBy({ left: offset, behavior: "instant" })
      })
    }
    const mutations = new MutationObserver(revealActiveTab)
    mutations.observe(viewport, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    })
    const resize = new ResizeObserver(revealActiveTab)
    resize.observe(viewport)
    if (viewport.firstElementChild) resize.observe(viewport.firstElementChild)
    viewport.addEventListener("click", revealActiveTab)
    revealActiveTab()
    return () => {
      cancelAnimationFrame(frame)
      mutations.disconnect()
      resize.disconnect()
      viewport.removeEventListener("click", revealActiveTab)
    }
  }, [])

  return (
    <div
      ref={viewportRef}
      className="min-w-0 overflow-x-auto pb-1"
      data-slot="tabs-scroll-viewport"
    >
      <TabsList {...props} />
    </div>
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-[background-color,border-color,color,box-shadow,opacity,transform] duration-150 ease-out group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-vertical/tabs:py-[calc(--spacing(1.25))] hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-transparent dark:data-active:bg-card dark:data-active:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-xs/relaxed outline-none", className)}
      {...props}
    />
  )
}

export {
  Tabs,
  TabsList,
  ScrollableTabsList,
  TabsTrigger,
  TabsContent,
  tabsListVariants,
}
