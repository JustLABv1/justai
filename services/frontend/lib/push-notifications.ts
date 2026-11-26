import { api } from "@/lib/api"

/** Browser push: one service worker, subscribed with the instance's VAPID key. */

const workerPath = "/notifications-sw.js"

export type PushState = "unsupported" | "denied" | "off" | "on"

export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  )
}

function keyBytes(base64url: string) {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration(workerPath)
  return registration ? registration.pushManager.getSubscription() : null
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported"
  if (Notification.permission === "denied") return "denied"
  return (await currentSubscription()) ? "on" : "off"
}

/** Asks for permission, subscribes this browser and registers it with JustAI. */
export async function enablePush(vapidPublicKey: string): Promise<PushState> {
  if (!pushSupported()) return "unsupported"
  const permission = await Notification.requestPermission()
  if (permission !== "granted")
    return permission === "denied" ? "denied" : "off"
  const registration = await navigator.serviceWorker.register(workerPath)
  await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(vapidPublicKey),
    }))
  await api.post(
    "/api/v1/notifications/push-subscriptions",
    subscription.toJSON()
  )
  return "on"
}

export async function disablePush(): Promise<PushState> {
  const subscription = await currentSubscription()
  if (subscription) {
    await api
      .delete("/api/v1/notifications/push-subscriptions", subscription.toJSON())
      .catch(() => undefined)
    await subscription.unsubscribe()
  }
  return pushSupported() ? "off" : "unsupported"
}
