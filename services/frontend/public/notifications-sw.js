/* JustAI notification service worker: shows Web Push messages and opens their link. */
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim())
)

self.addEventListener("push", (event) => {
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    message = { body: event.data ? event.data.text() : "" }
  }
  const title = message.title || "JustAI"
  event.waitUntil(
    self.registration.showNotification(title, {
      body: message.body || "",
      tag: message.tag || undefined,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: message.url || "/" },
    })
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const target = new URL(
    event.notification.data?.url || "/",
    self.location.origin
  )
  // Only open pages of this app.
  const url =
    target.origin === self.location.origin ? target.href : self.location.origin
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        for (const client of windows) {
          if (
            new URL(client.url).origin === self.location.origin &&
            "focus" in client
          ) {
            return client
              .focus()
              .then((focused) =>
                focused && "navigate" in focused
                  ? focused.navigate(url)
                  : undefined
              )
          }
        }
        return self.clients.openWindow(url)
      })
  )
})
