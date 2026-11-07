"use client"

import { useSyncExternalStore } from "react"

const key = "justai.seasons-disabled"
const changeEvent = "justai:season-preference"
let fallbackDisabled = false

function getSnapshot() {
  try {
    return window.localStorage.getItem(key) === "true"
  } catch {
    return fallbackDisabled
  }
}

function subscribe(onChange: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key === key || event.key === null) onChange()
  }
  window.addEventListener("storage", onStorage)
  window.addEventListener(changeEvent, onChange)
  return () => {
    window.removeEventListener("storage", onStorage)
    window.removeEventListener(changeEvent, onChange)
  }
}

export function setSeasonsDisabled(disabled: boolean) {
  fallbackDisabled = disabled
  try {
    window.localStorage.setItem(key, String(disabled))
  } catch {
    // Keep the preference for this page when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(changeEvent))
}

export function useSeasonsDisabled() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
