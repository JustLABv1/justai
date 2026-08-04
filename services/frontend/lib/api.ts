const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080"

export class APIError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "APIError"
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers,
  })
  if (!response.ok) {
    let message = response.statusText
    try {
      const payload = (await response.json()) as { error?: string }
      message = payload.error ?? message
    } catch {
      // Keep the HTTP status text when the backend did not return JSON.
    }
    throw new APIError(message, response.status)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return response.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
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
}

export function socketURL(path: string, ticket: string) {
  const httpURL = new URL(API_URL)
  httpURL.protocol = httpURL.protocol === "https:" ? "wss:" : "ws:"
  httpURL.pathname = path
  httpURL.search = `?ticket=${encodeURIComponent(ticket)}`
  return httpURL.toString()
}

export { API_URL }
