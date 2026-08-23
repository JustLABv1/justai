import type { AuthConfig } from "@/lib/types"

const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL

// Production images are built for same-origin routing by default. Local
// development still uses the standalone backend unless an explicit API URL
// is supplied. An empty NEXT_PUBLIC_API_URL is intentional: it produces
// relative browser requests such as /api/v1/auth/config.
export const API_URL =
  configuredApiUrl ??
  (process.env.NODE_ENV === "development" ? "http://localhost:8080" : "")

export function resolveAPIURL(path: string) {
  if (!path.startsWith("/") || !API_URL) return path
  return `${API_URL.replace(/\/$/, "")}${path}`
}
const REQUEST_TIMEOUT_MS = 30_000
type APIRequestInit = RequestInit & { timeoutMs?: number }

let selectedOrganizationId = ""
let hasLoadedOrganizationId = false

function organizationIdForRequest() {
  if (!hasLoadedOrganizationId && typeof window !== "undefined") {
    selectedOrganizationId =
      window.localStorage.getItem("justai.organizationId") || ""
    hasLoadedOrganizationId = true
  }
  return selectedOrganizationId
}

export class APIError extends Error {
  status: number
  code?: string
  requestId?: string
  details?: unknown

  constructor(
    message: string,
    status: number,
    options: { code?: string; requestId?: string; details?: unknown } = {}
  ) {
    super(message)
    this.name = "APIError"
    this.status = status
    this.code = options.code
    this.requestId = options.requestId
    this.details = options.details
  }
}

async function request<T>(path: string, init?: APIRequestInit): Promise<T> {
  const { timeoutMs, ...fetchInit } = init ?? {}
  const headers = new Headers(fetchInit.headers)
  if (!(fetchInit.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  const organizationId = organizationIdForRequest()
  if (organizationId && !headers.has("X-Organization-ID")) {
    headers.set("X-Organization-ID", organizationId)
  }
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    timeoutMs ?? REQUEST_TIMEOUT_MS
  )
  if (fetchInit.signal) {
    if (fetchInit.signal.aborted) controller.abort()
    else
      fetchInit.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      })
  }
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...fetchInit,
      credentials: "include",
      headers,
      cache: fetchInit.cache ?? "no-store",
      signal: controller.signal,
    })
  } catch (caught) {
    globalThis.clearTimeout(timeout)
    if (caught instanceof DOMException && caught.name === "AbortError") {
      if (fetchInit.signal?.aborted) {
        throw new APIError("The request was cancelled.", 499, {
          code: "request_aborted",
        })
      }
      throw new APIError("The request timed out. Please try again.", 408, {
        code: "request_timeout",
      })
    }
    throw new APIError("JustAI could not reach the backend.", 0, {
      code: "network_error",
    })
  }
  try {
    if (!response.ok) {
      let message = response.statusText
      let code: string | undefined
      let requestId: string | undefined
      let details: unknown
      try {
        const payload = (await response.json()) as {
          error?:
            | string
            | {
                message?: string
                code?: string
                requestId?: string
                details?: unknown
              }
          message?: string
          code?: string
          requestId?: string
          details?: unknown
        }
        const error =
          typeof payload.error === "object" ? payload.error : undefined
        message =
          error?.message ??
          (typeof payload.error === "string"
            ? payload.error
            : payload.message) ??
          message
        code = error?.code ?? payload.code
        requestId = error?.requestId ?? payload.requestId
        details = error?.details ?? payload.details
      } catch {
        // Keep the HTTP status text when the backend did not return JSON.
      }
      throw new APIError(message, response.status, { code, requestId, details })
    }
    if (response.status === 204) {
      return undefined as T
    }
    return (await response.json()) as T
  } finally {
    // Keep the timeout alive while the response body is being decoded. A
    // stalled JSON body must not leave history or context requests pending
    // forever and keep the chat on its loading screen.
    globalThis.clearTimeout(timeout)
  }
}

async function requestBlob(path: string, init?: RequestInit): Promise<Blob> {
  const headers = new Headers(init?.headers)
  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  const organizationId = organizationIdForRequest()
  if (organizationId && !headers.has("X-Organization-ID")) {
    headers.set("X-Organization-ID", organizationId)
  }
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  )
  if (init?.signal) {
    if (init.signal.aborted) controller.abort()
    else
      init.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      })
  }
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: "include",
      headers,
      cache: init?.cache ?? "no-store",
      signal: controller.signal,
    })
    if (!response.ok) {
      let message = response.statusText
      let code: string | undefined
      let requestId: string | undefined
      let details: unknown
      try {
        const payload = (await response.json()) as {
          error?:
            | string
            | {
                message?: string
                code?: string
                requestId?: string
                details?: unknown
              }
          message?: string
          code?: string
          requestId?: string
          details?: unknown
        }
        const error =
          typeof payload.error === "object" ? payload.error : undefined
        message =
          error?.message ??
          (typeof payload.error === "string"
            ? payload.error
            : payload.message) ??
          message
        code = error?.code ?? payload.code
        requestId = error?.requestId ?? payload.requestId
        details = error?.details ?? payload.details
      } catch {
        // Keep the HTTP status text when the backend did not return JSON.
      }
      throw new APIError(message, response.status, { code, requestId, details })
    }
    // Keep the timeout alive while the response body is being consumed. A
    // server that sends headers and then stalls must not leave a download
    // pending forever.
    return await response.blob()
  } catch (caught) {
    if (caught instanceof APIError) throw caught
    if (caught instanceof DOMException && caught.name === "AbortError") {
      if (init?.signal?.aborted) {
        throw new APIError("The request was cancelled.", 499, {
          code: "request_aborted",
        })
      }
      throw new APIError("The request timed out. Please try again.", 408, {
        code: "request_timeout",
      })
    }
    throw new APIError("JustAI could not reach the backend.", 0, {
      code: "network_error",
    })
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>(path, init),
  post: <T>(path: string, body?: unknown, init?: APIRequestInit) =>
    request<T>(path, {
      ...init,
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  postBlob: (path: string, body?: unknown) =>
    requestBlob(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  getBlob: (path: string) => requestBlob(path),
  patch: <T>(path: string, body: unknown, init?: RequestInit) =>
    request<T>(path, {
      ...init,
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  delete: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, {
      ...init,
      method: "DELETE",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  upload: <T>(path: string, body: FormData) =>
    request<T>(path, {
      method: "POST",
      body,
      headers: {},
    }),
  postWithAuth: <T>(path: string, token: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}` },
    }),
  binary: <T>(path: string, body: Blob, method: "PUT" | "POST" = "PUT") =>
    request<T>(path, {
      method,
      body,
      headers: { "Content-Type": body.type || "application/octet-stream" },
    }),
  getOrganizationId: () => organizationIdForRequest() || null,
  getAuthConfig: () => request<AuthConfig>("/api/v1/auth/config"),
  setOrganizationId: (organizationId: string | null) => {
    selectedOrganizationId = organizationId || ""
    hasLoadedOrganizationId = true
    if (typeof window !== "undefined") {
      if (selectedOrganizationId) {
        window.localStorage.setItem(
          "justai.organizationId",
          selectedOrganizationId
        )
      } else {
        window.localStorage.removeItem("justai.organizationId")
      }
    }
  },
}

export function socketURL(path: string, ticket: string) {
  const httpURL = new URL(
    API_URL ||
      (typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost:3000")
  )
  httpURL.protocol = httpURL.protocol === "https:" ? "wss:" : "ws:"
  httpURL.pathname = path
  httpURL.search = `?ticket=${encodeURIComponent(ticket)}`
  return httpURL.toString()
}
