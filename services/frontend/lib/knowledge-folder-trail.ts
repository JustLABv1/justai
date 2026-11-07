import { useSyncExternalStore } from "react"

/**
 * The folder the Storage page is showing, shared with the workspace's top bar
 * so its breadcrumb can show the whole path. The page publishes it while it is
 * mounted and clears it on the way out; nothing else needs to know about it.
 */
export type FolderTrail = {
  items: { id: string; name: string }[]
  /** Go to a folder, or to the top ("all"). */
  select: (id: string) => void
}

let current: FolderTrail | null = null
const listeners = new Set<() => void>()

export function publishFolderTrail(next: FolderTrail | null) {
  current = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useFolderTrail() {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  )
}
